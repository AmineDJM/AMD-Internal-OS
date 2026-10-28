import type { EntityType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { openSecret } from "@/lib/crypto/secret-box";
import { canAccessEntity, ENTITY_MODULE } from "@/lib/entity-access";
import { entityHref } from "@/lib/entity-href";
import { ENTITY_TYPE_LABELS, MODULE_LABELS } from "@/lib/labels";
import { TYPES_ENTITE_AD_PRO } from "@/lib/ad-pro/unified";
import type { Module, SessionUser } from "@/lib/rbac";
import { proposerLecture } from "@/lib/pieces-lues/service";
import { empreinteDe, texteDeLaLecture } from "@/lib/pieces-lues/lecture-fichier";
import type { EntetesReperes } from "@/lib/pieces-lues/entetes";
import type { PieceLue } from "@/lib/pieces-lues/structure";
import {
  IDENTITE_FACTURE_VIDE, comparerFactures, completerIdentite, identiteDepuisLecture, identiteDepuisSaisie,
  type FacturePourRecensement, type IdentiteFacture, type Rapprochement,
} from "@/lib/factures/identite";
import {
  phraseDeBlocage, phraseDoublonPossible, phraseMarque,
  type CibleRelance, type FactureDejaConnue, type MarqueDoublonPossible,
} from "@/lib/factures/blocage-vue";
import { etatDuPaiement, relancable, type EtatPaiement } from "@/lib/finance/relance-paiement";
import { signerJetonRelance } from "@/lib/factures/jeton-relance";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FACTURES CONNUES DE LA PLATEFORME — toutes les maisons, une seule lecture (Direction, 14/10/2026).
 *
 * Une facture vit à l'un de ces trois endroits — et la même facture peut, par erreur, vivre à deux :
 *   • REGISTRE   une pièce Legal de nature « facture », non annulée (Ad & Pro, Legal, matériel promotionnel, Budget) ;
 *   • DEMANDE    une pièce « Facture » d'une demande de paiement vivante (transmise, ni retirée ni refusée), non remplacée ;
 *   • FICHIER    un fichier de catégorie « Facture » posé sur un dossier (ordre de dépense, demande au secrétariat,
 *                poste, demande de paiement…) — ce que la règle des ordres compte déjà (`finance/facture-ordre.ts`).
 *
 * Pour chacune : son IDENTITÉ (`factures/identite.ts`) — la lecture de Luna gardée par empreinte (`LecturePiece`), à
 * défaut ce que le formulaire a saisi — ; le PAIEMENT qui la porte (l'ordre de dépense, sinon la demande) et son état ;
 * le dossier où elle vit ; et ses clés d'INSTANCE, pour ne pas prendre la facture d'un poste et sa copie dans le dossier
 * compagnon de son ordre pour deux factures.
 *
 * Deux lecteurs : le BLOCAGE aux portes de dépôt (`verifierFacturesAvantDepot`) et le RECENSEMENT unique des doublons
 * déjà en base (`factures/recensement.ts`). Rien ici n'écrit, sauf la lecture d'une pièce NOUVELLE (le cache de lecture
 * de Luna) et la marque « doublon possible » posée APRÈS un dépôt accepté.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type MaisonFacture = "REGISTRE" | "DEMANDE" | "FICHIER";

export interface OrdreDeLaFacture {
  id: string;
  reference: string;
  status: string;
  centralStatus: string;
  requestedById: string | null;
}

export interface DemandeDeLaFacture {
  id: string;
  reference: string;
  status: string;
  requesterId: string;
}

export interface FactureConnue extends FacturePourRecensement {
  maison: MaisonFacture;
  /** Le module, tel qu'on le dit à la personne (« Ad & Pro », « Demandes de paiement », « Legal », « Secrétariat »…). */
  module: string;
  pieceNom: string;
  documentId: string | null;
  /** Le dossier où elle vit — ce que l'accès juge, ce que le lien ouvre. */
  dossier: { type: EntityType; id: string; titre: string; montant: number | null; lien: string | null };
  ordre: OrdreDeLaFacture | null;
  /** La demande de paiement qui porte son paiement (la demande elle-même, ou le dossier compagnon de l'ordre). */
  demande: DemandeDeLaFacture | null;
  etat: EtatPaiement;
  /** Qui l'a déposée, ou qui demande son paiement. */
  porteurId: string | null;
  creeLe: string;
  marque: MarqueDoublonPossible | null;
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** La marque « doublon possible » gardée dans un `custom` (pièce Legal, ordre de dépense) ; `null` sinon. */
export function marqueDe(custom: unknown): MarqueDoublonPossible | null {
  if (!estObjet(custom) || !estObjet(custom.doublonPossible)) return null;
  const m = custom.doublonPossible;
  return typeof m.autre === "string" && typeof m.raison === "string"
    ? { autre: m.autre, module: typeof m.module === "string" ? m.module : "", raison: m.raison, le: typeof m.le === "string" ? m.le : "" }
    : null;
}

/** Le libellé de module d'un type de dossier — « Ad & Pro » pour toutes ses fiches. */
export function moduleDuDossier(type: string | null | undefined): string {
  if (!type) return "Legal";
  if (TYPES_ENTITE_AD_PRO.has(type)) return "Ad & Pro";
  if (type === "PAYMENT_REQUEST") return "Demandes de paiement";
  if (type === "ADMIN_REQUEST") return "Secrétariat";
  if (type === "EXPENSE_ORDER") return "Finances";
  if (type === "LEGAL_DOCUMENT") return "Legal";
  if (type === "PROMO_MATERIAL") return "Matériel promotionnel";
  const module = (ENTITY_MODULE as Record<string, Module | undefined>)[type];
  return ENTITY_TYPE_LABELS[type] ?? (module ? MODULE_LABELS[module] : null) ?? type;
}

/** Les identifiants des sociétés du groupe — le client de chaque pièce, jamais son émetteur. */
async function identifiantsDuGroupe(): Promise<{ nifs: string[]; rcs: string[] }> {
  const ids = await prisma.companyLegalIdentity.findMany({ select: { nif: true, rcNumber: true } });
  return { nifs: ids.map((i) => i.nif).filter((x): x is string => Boolean(x)), rcs: ids.map((i) => i.rcNumber).filter((x): x is string => Boolean(x)) };
}

/** Les empreintes SHA-256 des fichiers stockés, par clé de stockage (`StoredFile` → `FileBlob`). */
async function empreintesDesCles(cles: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniques = [...new Set(cles.filter(Boolean))];
  if (uniques.length === 0) return out;
  const stockes = await prisma.storedFile.findMany({ where: { key: { in: uniques } }, select: { key: true, blobId: true } });
  const blobs = stockes.length
    ? await prisma.fileBlob.findMany({ where: { id: { in: [...new Set(stockes.map((s) => s.blobId))] } }, select: { id: true, sha256: true } })
    : [];
  const sha = new Map(blobs.map((b) => [b.id, b.sha256]));
  for (const s of stockes) { const h = sha.get(s.blobId); if (h) out.set(s.key, h); }
  return out;
}

/** Les lectures de Luna gardées, par empreinte — l'identité LUE d'une facture déjà déposée, sans la relire. */
async function lecturesDesEmpreintes(empreintes: readonly string[]): Promise<Map<string, { entetes: EntetesReperes | null; piece: PieceLue | null; texte: string | null }>> {
  const out = new Map<string, { entetes: EntetesReperes | null; piece: PieceLue | null; texte: string | null }>();
  const uniques = [...new Set(empreintes)];
  if (uniques.length === 0) return out;
  const lignes = await prisma.lecturePiece.findMany({
    where: { empreinte: { in: uniques }, etat: "LUE" },
    select: { empreinte: true, entetes: true, structure: true, texteScelle: true, versionLecteur: true },
    orderBy: { versionLecteur: "desc" },
  });
  for (const l of lignes) {
    if (out.has(l.empreinte)) continue;
    let texte: string | null = null;
    try { texte = l.texteScelle ? openSecret(l.texteScelle) : null; } catch { texte = null; }
    const e = estObjet(l.entetes) && Array.isArray((l.entetes as Record<string, unknown>).nif) ? (l.entetes as unknown as EntetesReperes) : null;
    const p = estObjet(l.structure) && Array.isArray((l.structure as Record<string, unknown>).lignes) ? (l.structure as unknown as PieceLue) : null;
    out.set(l.empreinte, { entetes: e, piece: p, texte });
  }
  return out;
}

/** L'identité d'une facture stockée : sa lecture gardée si elle en a une, complétée par ce qui a été saisi. */
function identiteStockee(
  empreinte: string | null,
  lectures: Map<string, { entetes: EntetesReperes | null; piece: PieceLue | null; texte: string | null }>,
  groupe: { nifs: string[]; rcs: string[] },
  saisie: Parameters<typeof identiteDepuisSaisie>[0] | null,
): IdentiteFacture {
  const lue = empreinte ? lectures.get(empreinte) : undefined;
  const saisieId = saisie ? identiteDepuisSaisie({ ...saisie, empreintes: empreinte ? [empreinte] : [] }) : null;
  if (!lue) return saisieId ?? { ...IDENTITE_FACTURE_VIDE, empreintes: empreinte ? [empreinte] : [] };
  return completerIdentite(identiteDepuisLecture({ empreintes: [empreinte], texte: lue.texte, entetes: lue.entetes, piece: lue.piece, groupe }), saisieId);
}

/**
 * LE TTC LU des factures déjà STOCKÉES (pièces d'une demande de paiement), par document — `null` quand la pièce n'a pas de
 * lecture gardée. Aucune relecture : Luna a lu la pièce à son dépôt (`verifierFacturesAvantDepot`), la lecture est gardée
 * par empreinte. Sert à confronter le montant d'une demande à ses factures au moment de la transmettre
 * (`finance/montant-facture.ts`). Une base indisponible rend des `null` : le montant est alors dit « non vérifié ».
 */
export async function ttcDesFacturesStockees(documentIds: readonly string[]): Promise<Map<string, number | null>> {
  const ids = [...new Set(documentIds.filter(Boolean))];
  const out = new Map<string, number | null>(ids.map((id) => [id, null]));
  if (ids.length === 0) return out;
  try {
    const docs = await prisma.document.findMany({ where: { id: { in: ids } }, select: { id: true, fileKey: true } });
    const empreintes = await empreintesDesCles(docs.map((d) => d.fileKey ?? ""));
    const lectures = await lecturesDesEmpreintes([...empreintes.values()]);
    if (lectures.size === 0) return out;
    const groupe = await identifiantsDuGroupe();
    for (const d of docs) {
      const empreinte = d.fileKey ? empreintes.get(d.fileKey) ?? null : null;
      if (empreinte && lectures.has(empreinte)) out.set(d.id, identiteStockee(empreinte, lectures, groupe, null).ttc);
    }
  } catch (err) {
    console.error("[factures] TTC des factures stockées illisible (le montant reste non vérifié)", err);
  }
  return out;
}

const ORDRE_SELECT = { id: true, reference: true, status: true, centralStatus: true, requestedById: true } as const;

/**
 * LES DOSSIERS DONT UN FICHIER « FACTURE » EST UNE FACTURE À PAYER — l'ordre de dépense (la facture jointe au
 * paiement), la demande au secrétariat (« Terminer » avec sa facture), le poste Ad & Pro, la demande de paiement.
 * Un fichier « Facture » rangé ailleurs (une pièce justificative de note de frais, une demande de pièce) n'est pas
 * une facture qu'on paie par ce circuit.
 */
export const MAISONS_FICHIER: readonly EntityType[] = ["EXPENSE_ORDER", "ADMIN_REQUEST", "AD_PRO_ITEM", "PAYMENT_REQUEST"];

/**
 * TOUTES LES FACTURES CONNUES — en lot : une poignée de requêtes, quel que soit leur nombre. `limite` borne chaque
 * maison aux plus récentes (le recensement lit tout ; le blocage aussi, la base reste de taille humaine).
 */
export async function chargerFacturesConnues(opts: { limite?: number } = {}): Promise<FactureConnue[]> {
  const take = opts.limite ?? 20_000;
  const [registre, pieces, fichiers, groupe] = await Promise.all([
    prisma.legalDocument.findMany({
      where: { kind: "INVOICE", status: { not: "CANCELLED" } },
      select: {
        id: true, title: true, reference: true, counterparty: true, amount: true, sourceType: true, sourceId: true,
        expenseOrderId: true, createdById: true, createdAt: true, custom: true,
      },
      orderBy: { createdAt: "desc" }, take,
    }),
    prisma.paymentPiece.findMany({
      where: { kind: "INVOICE", replacedBy: { is: null }, request: { status: { notIn: ["DRAFT", "CANCELLED", "REJECTED"] } } },
      select: {
        id: true, documentId: true, createdAt: true, createdById: true,
        request: { select: { id: true, reference: true, title: true, amount: true, status: true, requesterId: true, expenseOrderId: true, payee: true } },
      },
      orderBy: { createdAt: "desc" }, take,
    }),
    prisma.document.findMany({
      // Les dossiers qui PAIENT une facture : l'ordre de dépense, la demande au secrétariat, le poste, la demande de paiement.
      where: { category: "INVOICE", entityType: { in: [...MAISONS_FICHIER] } },
      select: { id: true, name: true, fileKey: true, entityType: true, entityId: true, createdAt: true, uploadedById: true },
      orderBy: { createdAt: "desc" }, take,
    }),
    identifiantsDuGroupe(),
  ]);

  // Les fichiers : le PREMIER document de chaque pièce du registre (la facture ; les suivants sont ses annexes).
  const docsRegistre = registre.length
    ? await prisma.document.findMany({
        where: { entityType: "LEGAL_DOCUMENT", entityId: { in: registre.map((r) => r.id) } },
        select: { id: true, name: true, fileKey: true, entityId: true }, orderBy: { createdAt: "asc" },
      })
    : [];
  const premierDoc = new Map<string, { id: string; name: string; fileKey: string | null }>();
  for (const d of docsRegistre) if (!premierDoc.has(d.entityId)) premierDoc.set(d.entityId, d);
  const docsPieces = pieces.length
    ? await prisma.document.findMany({ where: { id: { in: pieces.map((p) => p.documentId) } }, select: { id: true, name: true, fileKey: true } })
    : [];
  const docPiece = new Map(docsPieces.map((d) => [d.id, d]));

  // Les postes Ad & Pro des pièces du registre (la facture rattachée à un poste) — clé d'instance, et l'ordre du poste.
  const liens = registre.length
    ? await prisma.adProItemPiece.findMany({ where: { legalDocumentId: { in: registre.map((r) => r.id) } }, select: { itemId: true, legalDocumentId: true } })
    : [];
  const postesDe = new Map<string, string[]>();
  for (const l of liens) postesDe.set(l.legalDocumentId, [...(postesDe.get(l.legalDocumentId) ?? []), l.itemId]);

  // Les dossiers des fichiers libres.
  const parType = (t: string) => fichiers.filter((f) => f.entityType === t).map((f) => f.entityId);
  const idsItems = [...new Set([...parType("AD_PRO_ITEM"), ...liens.map((l) => l.itemId)])];
  const [items, demandesFichiers, secretariat, ordresDesFiches] = await Promise.all([
    idsItems.length ? prisma.adProItem.findMany({ where: { id: { in: idsItems } }, select: { id: true, label: true, expenseOrderId: true, createdById: true } }) : Promise.resolve([]),
    parType("PAYMENT_REQUEST").length
      ? prisma.paymentRequest.findMany({ where: { id: { in: parType("PAYMENT_REQUEST") } }, select: { id: true, reference: true, title: true, amount: true, status: true, requesterId: true, expenseOrderId: true } })
      : Promise.resolve([]),
    parType("ADMIN_REQUEST").length
      ? prisma.administrativeRequest.findMany({ where: { id: { in: parType("ADMIN_REQUEST") } }, select: { id: true, reference: true, title: true, status: true, requesterId: true } })
      : Promise.resolve([]),
    parType("ADMIN_REQUEST").length
      ? prisma.expenseOrder.findMany({ where: { sourceType: "ADMIN_REQUEST", sourceId: { in: parType("ADMIN_REQUEST") } }, select: { ...ORDRE_SELECT, sourceId: true }, orderBy: { createdAt: "desc" } })
      : Promise.resolve([] as (OrdreDeLaFacture & { sourceId: string | null })[]),
  ]);
  const itemDe = new Map(items.map((i) => [i.id, i]));
  const demandeFichierDe = new Map(demandesFichiers.map((d) => [d.id, d]));
  const secretariatDe = new Map(secretariat.map((d) => [d.id, d]));
  const ordreDeFiche = new Map<string, OrdreDeLaFacture>();
  for (const o of ordresDesFiches) if (o.sourceId && (!ordreDeFiche.has(o.sourceId) || ordreDeFiche.get(o.sourceId)!.status === "CANCELLED")) ordreDeFiche.set(o.sourceId, o);

  // Les ordres de dépense de tout le monde, en une fois.
  const idsOrdres = new Set<string>();
  for (const r of registre) if (r.expenseOrderId) idsOrdres.add(r.expenseOrderId);
  for (const p of pieces) if (p.request.expenseOrderId) idsOrdres.add(p.request.expenseOrderId);
  for (const f of fichiers) if (f.entityType === "EXPENSE_ORDER") idsOrdres.add(f.entityId);
  for (const i of items) if (i.expenseOrderId) idsOrdres.add(i.expenseOrderId);
  for (const d of demandesFichiers) if (d.expenseOrderId) idsOrdres.add(d.expenseOrderId);
  const ordres = idsOrdres.size
    ? await prisma.expenseOrder.findMany({ where: { id: { in: [...idsOrdres] } }, select: { ...ORDRE_SELECT, label: true, amount: true, custom: true } })
    : [];
  const ordreDe = new Map(ordres.map((o) => [o.id, o]));
  // La demande de paiement qui porte chaque ordre (la demande elle-même, ou son dossier compagnon).
  const porteuses = ordres.length
    ? await prisma.paymentRequest.findMany({
        where: { expenseOrderId: { in: ordres.map((o) => o.id) } },
        select: { id: true, reference: true, status: true, requesterId: true, expenseOrderId: true }, orderBy: { createdAt: "asc" },
      })
    : [];
  const demandeDeLOrdre = new Map<string, DemandeDeLaFacture>();
  for (const d of porteuses) if (d.expenseOrderId && !demandeDeLOrdre.has(d.expenseOrderId)) demandeDeLOrdre.set(d.expenseOrderId, d);

  // Les empreintes, puis les lectures gardées.
  const cles = [
    ...[...premierDoc.values()].map((d) => d.fileKey),
    ...docsPieces.map((d) => d.fileKey),
    ...fichiers.map((f) => f.fileKey),
  ].filter((k): k is string => Boolean(k));
  const shaDeCle = await empreintesDesCles(cles);
  const lectures = await lecturesDesEmpreintes([...shaDeCle.values()]);
  const sha = (k: string | null | undefined) => (k ? shaDeCle.get(k) ?? null : null);

  const out: FactureConnue[] = [];
  const ordreSimple = (id: string | null | undefined): OrdreDeLaFacture | null => {
    const o = id ? ordreDe.get(id) : undefined;
    return o ? { id: o.id, reference: o.reference, status: o.status, centralStatus: o.centralStatus, requestedById: o.requestedById } : null;
  };

  // ── REGISTRE ──
  for (const r of registre) {
    const doc = premierDoc.get(r.id) ?? null;
    const postes = postesDe.get(r.id) ?? [];
    const ordre = ordreSimple(r.expenseOrderId ?? postes.map((p) => itemDe.get(p)?.expenseOrderId).find(Boolean) ?? null);
    const demande = ordre ? demandeDeLOrdre.get(ordre.id) ?? null : null;
    const etatBrut = etatDuPaiement({ ordre, demande });
    // UNE FACTURE DU REGISTRE DONT LE PAIEMENT A ÉTÉ ANNULÉ RESTE ENREGISTRÉE : le poste peut la repayer.
    const etat: EtatPaiement = etatBrut === "CLOS" ? "HORS_PAIEMENT" : etatBrut;
    const adPro = r.sourceType && TYPES_ENTITE_AD_PRO.has(r.sourceType);
    const dossier = r.sourceType && r.sourceId
      ? { type: r.sourceType, id: r.sourceId, titre: r.title, montant: num(r.amount), lien: entityHref(r.sourceType, r.sourceId) }
      : { type: "LEGAL_DOCUMENT" as EntityType, id: r.id, titre: r.title, montant: num(r.amount), lien: `/legal/${r.id}` };
    const instances = [
      `LEGAL:${r.id}`, ...(ordre ? [`ORDRE:${ordre.id}`] : []), ...postes.map((p) => `POSTE:${p}`),
      // La fiche porteuse, sauf une opération Ad & Pro : elle porte plusieurs postes, donc plusieurs factures.
      ...(r.sourceType && r.sourceId && !adPro ? [`FICHE:${r.sourceType}:${r.sourceId}`] : []),
    ];
    out.push({
      cle: `REGISTRE:${r.id}`, maison: "REGISTRE", module: moduleDuDossier(r.sourceType ?? "LEGAL_DOCUMENT"),
      pieceNom: doc?.name ?? r.title, documentId: doc?.id ?? null, dossier, ordre, demande, etat,
      porteurId: demande?.requesterId ?? ordre?.requestedById ?? r.createdById ?? null,
      creeLe: r.createdAt.toISOString(), marque: marqueDe(r.custom),
      instances,
      identite: identiteStockee(sha(doc?.fileKey), lectures, groupe, { numero: r.reference, fournisseur: r.counterparty, ttc: num(r.amount), titre: r.title }),
    });
  }

  // ── DEMANDES DE PAIEMENT ──
  for (const p of pieces) {
    const doc = docPiece.get(p.documentId) ?? null;
    const req = p.request;
    const ordre = ordreSimple(req.expenseOrderId);
    const demande: DemandeDeLaFacture = { id: req.id, reference: req.reference, status: req.status, requesterId: req.requesterId };
    out.push({
      cle: `DEMANDE:${p.id}`, maison: "DEMANDE", module: "Demandes de paiement",
      pieceNom: doc?.name ?? "Facture", documentId: doc?.id ?? null,
      dossier: { type: "PAYMENT_REQUEST", id: req.id, titre: `${req.reference} — ${req.title}`, montant: num(req.amount), lien: `/validations/paiements/${req.id}` },
      ordre, demande, etat: etatDuPaiement({ ordre, demande }),
      porteurId: req.requesterId, creeLe: p.createdAt.toISOString(),
      marque: ordre ? marqueDe(ordreDe.get(ordre.id)?.custom) : null,
      instances: [`DEMANDE:${req.id}`, ...(ordre ? [`ORDRE:${ordre.id}`] : [])],
      identite: identiteStockee(sha(doc?.fileKey), lectures, groupe, { fournisseur: req.payee }),
    });
  }

  // ── FICHIERS « Facture » posés sur un dossier ──
  for (const f of fichiers) {
    const t = f.entityType;
    let ordre: OrdreDeLaFacture | null = null;
    let titre = f.name;
    let montant: number | null = null;
    let porteurId: string | null = f.uploadedById ?? null;
    const instances: string[] = [`FICHE:${t}:${f.entityId}`];
    if (t === "EXPENSE_ORDER") {
      ordre = ordreSimple(f.entityId);
      const o = ordreDe.get(f.entityId);
      if (!o || o.status === "CANCELLED") continue;
      titre = `${o.reference} — ${o.label}`;
      montant = num(o.amount);
    } else if (t === "AD_PRO_ITEM") {
      const it = itemDe.get(f.entityId);
      ordre = ordreSimple(it?.expenseOrderId);
      titre = it?.label ?? f.name;
      instances.push(`POSTE:${f.entityId}`);
    } else if (t === "PAYMENT_REQUEST") {
      const d = demandeFichierDe.get(f.entityId);
      if (!d || ["DRAFT", "CANCELLED", "REJECTED"].includes(d.status)) continue;
      ordre = ordreSimple(d.expenseOrderId);
      titre = `${d.reference} — ${d.title}`;
      montant = num(d.amount);
      porteurId = d.requesterId;
      instances.push(`DEMANDE:${d.id}`);
    } else if (t === "ADMIN_REQUEST") {
      const d = secretariatDe.get(f.entityId);
      if (!d || d.status === "CANCELLED") continue;
      ordre = ordreDeFiche.get(f.entityId) ?? null;
      titre = `${d.reference} — ${d.title}`;
      porteurId = d.requesterId ?? porteurId;
    }
    if (ordre) instances.push(`ORDRE:${ordre.id}`);
    const demande = ordre ? demandeDeLOrdre.get(ordre.id) ?? null : null;
    const etatBrut = etatDuPaiement({ ordre, demande });
    out.push({
      cle: `FICHIER:${f.id}`, maison: "FICHIER", module: moduleDuDossier(t),
      pieceNom: f.name, documentId: f.id,
      dossier: { type: t, id: f.entityId, titre, montant, lien: entityHref(t, f.entityId) },
      ordre, demande, etat: etatBrut === "CLOS" ? "HORS_PAIEMENT" : etatBrut,
      porteurId, creeLe: f.createdAt.toISOString(),
      marque: ordre ? marqueDe(ordreDe.get(ordre.id)?.custom) : null,
      instances,
      identite: identiteStockee(sha(f.fileKey), lectures, groupe, null),
    });
  }
  return out;
}

// ─────────────────────────────── Lire la pièce qu'on dépose ───────────────────────────────

/**
 * L'IDENTITÉ DE LA PIÈCE QU'ON DÉPOSE — lue par Luna (`proposerLecture` : Luna quand la pièce peut sortir, le moteur
 * local sinon ; une lecture par empreinte, gardée). Une lecture qui échoue ne fait jamais échouer le dépôt : l'empreinte,
 * elle, se calcule toujours, et le même fichier se reconnaît sans lecture.
 */
export async function lireIdentiteDuDepot(userId: string, octets: Buffer, nomFichier: string): Promise<IdentiteFacture> {
  const empreinte = empreinteDe(octets);
  const repli: IdentiteFacture = { ...IDENTITE_FACTURE_VIDE, empreintes: [empreinte], reserves: [] };
  try {
    const groupe = await identifiantsDuGroupe();
    const r = await proposerLecture({
      user: { id: userId }, octets, nomFichier,
      contexte: { cible: "LEGAL_DOCUMENT", sortieCloudPermise: true, annuaireVisible: [], groupe },
    });
    if (!r.ok) return { ...repli, reserves: [`Pièce non lue : ${r.error}`] };
    const p = r.proposition;
    const texte = await texteDeLaLecture(p.lectureId).catch(sansBloquer("connues.lireIdentiteDuDepot.texteDeLaLecture", null));
    return identiteDepuisLecture({ empreintes: [empreinte], texte, entetes: p.entetes, piece: p.piece, groupe });
  } catch (err) {
    console.error("[factures] lecture de la pièce déposée impossible (le dépôt continue)", err);
    return { ...repli, reserves: ["La lecture de la pièce a échoué : seul le fichier est comparé."] };
  }
}

// ─────────────────────────────── Chercher une facture connue ───────────────────────────────

export interface ContexteDepot {
  /**
   * Les clés d'instance du dossier OÙ l'on dépose (`DEMANDE:<id>`, `ORDRE:<id>`, `POSTE:<id>`, `LEGAL:<id>`,
   * `FICHE:<type>:<id>`) : une facture déjà dans CE dossier n'est pas un second paiement — le circuit du dossier en
   * juge (remplacement d'une pièce, BC déjà facturé).
   */
  instances: readonly string[];
}

export interface Trouvaille {
  niveau: "CERTAIN" | "PROBABLE" | "AUCUN";
  connue: FactureConnue | null;
  rapprochement: Rapprochement | null;
}

/**
 * LA FACTURE EST-ELLE DÉJÀ CONNUE ? — la plus forte des correspondances, hors du dossier où l'on dépose. Un CERTAIN
 * l'emporte sur un PROBABLE ; entre deux CERTAINS, celle qui attend encore (au centre, chez les Finances) avant celle
 * qui est payée — c'est elle qu'on propose de relancer.
 */
export function chercherFactureConnue(identite: IdentiteFacture, connues: readonly FactureConnue[], contexte: ContexteDepot): Trouvaille {
  const dansCeDossier = (f: FactureConnue) => f.instances.some((k) => contexte.instances.includes(k));
  const rang = (n: Trouvaille["niveau"]) => (n === "CERTAIN" ? 2 : n === "PROBABLE" ? 1 : 0);
  let meilleur: Trouvaille = { niveau: "AUCUN", connue: null, rapprochement: null };
  for (const f of connues) {
    if (dansCeDossier(f)) continue;
    const r = comparerFactures(identite, f.identite);
    if (r.niveau === "AUCUN") continue;
    const mieux = !meilleur.connue
      || rang(r.niveau) > rang(meilleur.niveau)
      || (rang(r.niveau) === rang(meilleur.niveau) && !relancable(meilleur.connue.etat) && relancable(f.etat));
    if (mieux) meilleur = { niveau: r.niveau, connue: f, rapprochement: r };
  }
  return meilleur;
}

/** La cible d'une relance pour une facture connue : son ordre de dépense, sinon sa demande. */
export function cibleDeRelance(f: Pick<FactureConnue, "ordre" | "demande">): CibleRelance | null {
  if (f.ordre) return { type: "EXPENSE_ORDER", id: f.ordre.id };
  if (f.demande) return { type: "PAYMENT_REQUEST", id: f.demande.id };
  return null;
}

/** Le chef du département de qui porte le dossier — dit à qui y a accès, pour savoir à qui parler. */
async function chefDuDepartement(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const e = await prisma.employee.findUnique({
    where: { userId }, select: { departmentRef: { select: { name: true, head: { select: { fullName: true } } } } },
  });
  const d = e?.departmentRef;
  if (!d) return null;
  return d.head?.fullName ? `${d.head.fullName} (${d.name})` : null;
}

/** LA VUE DU BLOCAGE pour la personne arrêtée — avec ou sans accès au dossier, et le jeton de relance. */
export async function vueDuBlocage(user: SessionUser, identite: IdentiteFacture, f: FactureConnue): Promise<FactureDejaConnue> {
  const acces = await canAccessEntity(user, f.dossier.type, f.dossier.id, "VIEW").catch(sansBloquer("connues.vueDuBlocage.canAccessEntity", false));
  const cible = relancable(f.etat) ? cibleDeRelance(f) : null;
  const phrase = phraseDeBlocage(
    { numero: identite.numero, fournisseur: identite.fournisseur.nom, ttc: identite.ttc },
    {
      module: f.module, acces, titre: acces ? f.dossier.titre : null, montant: acces ? f.dossier.montant : null,
      lien: acces ? f.dossier.lien : null, etat: f.etat, chefDeDepartement: acces ? await chefDuDepartement(f.porteurId) : null,
    },
  );
  return {
    niveau: "CERTAIN", phrase, etat: f.etat, module: f.module, lien: acces ? f.dossier.lien : null,
    relance: cible ? { cible, jeton: signerJetonRelance(user.id, cible.type, cible.id) } : null,
  };
}

/** Un fichier qu'on dépose, et ce que le formulaire en dit à côté (n° saisi, fournisseur, montant). */
export interface FichierDepose {
  octets: Buffer;
  nom: string;
  saisie?: { numero?: string | null; fournisseur?: string | null; ttc?: number | null } | null;
}

export interface ProbableDuDepot {
  /** L'index du fichier dans le lot. */
  index: number;
  connue: FactureConnue;
  raison: string;
  /** L'avertissement montré à la personne. */
  phrase: string;
  /** La marque à poser sur la pièce déposée. */
  marque: MarqueDoublonPossible;
}

export type VerdictDepot =
  | { ok: true; identites: IdentiteFacture[]; probables: ProbableDuDepot[] }
  | { ok: false; error: string; factureConnue: FactureDejaConnue; index: number };

/**
 * LA GARDE DES PORTES DE DÉPÔT — appelée AVANT toute écriture. Pour chaque fichier « facture » du lot : le même fichier
 * d'abord (sans lecture), puis la lecture de Luna et la comparaison. Un CERTAIN refuse le lot entier avec la phrase du
 * blocage et la relance ; un PROBABLE laisse passer avec un avertissement et la marque à poser. Une panne de la garde
 * ne bloque JAMAIS un dépôt : elle se journalise, et le dépôt continue.
 */
export async function verifierFacturesAvantDepot(user: SessionUser, fichiers: readonly FichierDepose[], contexte: ContexteDepot): Promise<VerdictDepot> {
  if (fichiers.length === 0) return { ok: true, identites: [], probables: [] };
  try {
    const connues = await chargerFacturesConnues();
    const identites: IdentiteFacture[] = [];
    const probables: ProbableDuDepot[] = [];
    for (const [index, fichier] of fichiers.entries()) {
      // 1 — LE MÊME FICHIER : reconnu sans lecture (et sans faire attendre Luna).
      const empreinte = empreinteDe(fichier.octets);
      const parFichier = chercherFactureConnue({ ...IDENTITE_FACTURE_VIDE, empreintes: [empreinte] }, connues, contexte);
      let identite: IdentiteFacture;
      let trouvaille: Trouvaille;
      if (parFichier.niveau === "CERTAIN" && parFichier.connue) {
        identite = { ...IDENTITE_FACTURE_VIDE, empreintes: [empreinte] };
        trouvaille = parFichier;
      } else {
        // 2 — LA LECTURE (Luna), complétée par la saisie, comparée à toutes les maisons.
        const lue = await lireIdentiteDuDepot(user.id, fichier.octets, fichier.nom);
        const saisie = fichier.saisie ? identiteDepuisSaisie({ ...fichier.saisie }) : null;
        identite = completerIdentite(lue, saisie);
        trouvaille = chercherFactureConnue(identite, connues, contexte);
      }
      identites.push(identite);
      if (trouvaille.niveau === "CERTAIN" && trouvaille.connue) {
        const vue = await vueDuBlocage(user, identite, trouvaille.connue);
        return { ok: false, error: vue.phrase, factureConnue: vue, index };
      }
      if (trouvaille.niveau === "PROBABLE" && trouvaille.connue && trouvaille.rapprochement) {
        const f = trouvaille.connue;
        const acces = await canAccessEntity(user, f.dossier.type, f.dossier.id, "VIEW").catch(sansBloquer("connues.verifierFacturesAvantDepot.canAccessEntity", false));
        const raison = trouvaille.rapprochement.raison;
        probables.push({
          index, connue: f, raison,
          phrase: phraseDoublonPossible(raison, { module: f.module, acces, titre: f.dossier.titre }),
          marque: { autre: autreReference(f), module: f.module, raison, le: new Date().toISOString() },
        });
      }
    }
    return { ok: true, identites, probables };
  } catch (err) {
    console.error("[factures] garde des doublons indisponible (le dépôt continue)", err);
    return { ok: true, identites: [], probables: [] };
  }
}

/** La référence de l'autre pièce, telle que la marque la garde (lue par le centre et les Finances). */
export function autreReference(f: Pick<FactureConnue, "ordre" | "demande" | "dossier" | "pieceNom">): string {
  const ref = f.demande?.reference ?? f.ordre?.reference ?? null;
  return ref ? `${ref} (${f.pieceNom})` : `« ${f.dossier.titre} » (${f.pieceNom})`;
}

// ─────────────────────────────── La marque « doublon possible » ───────────────────────────────

/** Ajoute la marque dans un `custom` existant, sans rien effacer d'autre. */
function avecMarque(custom: unknown, m: MarqueDoublonPossible): Prisma.InputJsonValue {
  const base = estObjet(custom) ? { ...custom } : {};
  return { ...base, doublonPossible: { ...m } } as unknown as Prisma.InputJsonValue;
}

/**
 * POSER LA MARQUE après un dépôt ACCEPTÉ — sur la pièce du registre, sur l'ordre de dépense, et dans le fil de la
 * demande de paiement : là où le centre de paiement et les Finances la liront. Best-effort : une marque qui ne se pose
 * pas ne défait pas le dépôt.
 */
export async function marquerDoublonPossible(i: {
  marque: MarqueDoublonPossible; legalDocumentId?: string | null; ordreIds?: readonly (string | null | undefined)[]; demandeId?: string | null; acteurId?: string | null;
}): Promise<void> {
  try {
    if (i.legalDocumentId) {
      const d = await prisma.legalDocument.findUnique({ where: { id: i.legalDocumentId }, select: { custom: true } });
      if (d) await prisma.legalDocument.update({ where: { id: i.legalDocumentId }, data: { custom: avecMarque(d.custom, i.marque) } });
    }
    for (const id of new Set((i.ordreIds ?? []).filter((x): x is string => Boolean(x)))) {
      const o = await prisma.expenseOrder.findUnique({ where: { id }, select: { custom: true } });
      if (o) await prisma.expenseOrder.update({ where: { id }, data: { custom: avecMarque(o.custom, i.marque) } });
    }
    if (i.demandeId) {
      await prisma.paymentRequestEvent.create({
        data: { requestId: i.demandeId, actorId: i.acteurId ?? null, kind: "DOUBLON_POSSIBLE", message: phraseMarque(i.marque) },
      });
    }
  } catch (err) {
    console.error("[factures] marque « doublon possible » non posée (non bloquant)", err);
  }
}

/**
 * LES MARQUES DES ORDRES — lues par le centre de paiement et par « Banque & paiements » : la marque de l'ordre, celle
 * des factures du registre qui le paient, celle du fil de sa demande. Une phrase par ordre marqué.
 */
export async function marquesDesOrdres(orderIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (orderIds.length === 0) return out;
  const ids = [...new Set(orderIds)];
  const [ordres, registre, demandes] = await Promise.all([
    prisma.expenseOrder.findMany({ where: { id: { in: ids } }, select: { id: true, custom: true } }),
    prisma.legalDocument.findMany({ where: { expenseOrderId: { in: ids }, kind: "INVOICE", status: { not: "CANCELLED" } }, select: { expenseOrderId: true, custom: true } }),
    prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ids } }, select: { id: true, expenseOrderId: true } }),
  ]);
  for (const o of ordres) { const m = marqueDe(o.custom); if (m) out.set(o.id, phraseMarque(m)); }
  for (const r of registre) { const m = marqueDe(r.custom); if (m && r.expenseOrderId && !out.has(r.expenseOrderId)) out.set(r.expenseOrderId, phraseMarque(m)); }
  if (demandes.length) {
    const ev = await prisma.paymentRequestEvent.findMany({
      where: { requestId: { in: demandes.map((d) => d.id) }, kind: "DOUBLON_POSSIBLE" }, select: { requestId: true, message: true }, orderBy: { at: "desc" },
    });
    const ordreDe = new Map(demandes.map((d) => [d.id, d.expenseOrderId as string]));
    for (const e of ev) { const o = ordreDe.get(e.requestId); if (o && e.message && !out.has(o)) out.set(o, e.message); }
  }
  return out;
}

// ─────────────────────────────── Le dépôt libre d'un fichier « Facture » ───────────────────────────────

export interface GardeDepotLibre {
  /** Les fichiers à refuser (index dans le lot → la phrase du blocage). */
  refus: Map<number, string>;
  /** Après l'enregistrement : poser les marques « doublon possible ». */
  apres: () => Promise<void>;
}

/**
 * LE DÉPÔT LIBRE (`/api/documents/upload`) — la facture ajoutée à une pièce du registre qui n'en a pas encore (son
 * premier fichier : les suivants sont ses annexes), ou un fichier de catégorie « Facture » posé sur un dossier
 * (demande au secrétariat, ordre de dépense, demande de paiement, poste). Même garde que les autres portes.
 */
export async function gardeDuDepotLibre(
  user: SessionUser, cible: { entityType: string; entityId: string; category: string }, fichiers: readonly { octets: Buffer; nom: string }[],
): Promise<GardeDepotLibre> {
  const rien: GardeDepotLibre = { refus: new Map(), apres: async () => {} };
  try {
    let aGarder: number[] = [];
    let instances: string[] = [];
    let legalDocumentId: string | null = null;
    let ordreIds: string[] = [];
    let demandeId: string | null = null;
    if (cible.entityType === "LEGAL_DOCUMENT") {
      const d = await prisma.legalDocument.findUnique({ where: { id: cible.entityId }, select: { kind: true, direction: true, expenseOrderId: true } });
      if (!d || d.kind !== "INVOICE" || d.direction === "IN") return rien;
      const deja = await prisma.document.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: cible.entityId } });
      if (deja > 0) return rien;
      aGarder = fichiers.length > 0 ? [0] : [];
      instances = [`LEGAL:${cible.entityId}`, ...(d.expenseOrderId ? [`ORDRE:${d.expenseOrderId}`] : [])];
      legalDocumentId = cible.entityId;
      ordreIds = d.expenseOrderId ? [d.expenseOrderId] : [];
    } else if (cible.category === "INVOICE" && (MAISONS_FICHIER as readonly string[]).includes(cible.entityType)) {
      aGarder = fichiers.map((_, i) => i);
      instances = [`FICHE:${cible.entityType}:${cible.entityId}`];
      if (cible.entityType === "EXPENSE_ORDER") { instances.push(`ORDRE:${cible.entityId}`); ordreIds = [cible.entityId]; }
      if (cible.entityType === "AD_PRO_ITEM") instances.push(`POSTE:${cible.entityId}`);
      if (cible.entityType === "PAYMENT_REQUEST") {
        instances.push(`DEMANDE:${cible.entityId}`);
        demandeId = cible.entityId;
        const d = await prisma.paymentRequest.findUnique({ where: { id: cible.entityId }, select: { expenseOrderId: true } });
        if (d?.expenseOrderId) { instances.push(`ORDRE:${d.expenseOrderId}`); ordreIds = [d.expenseOrderId]; }
      }
    }
    if (aGarder.length === 0) return rien;
    const refus = new Map<number, string>();
    const marques: MarqueDoublonPossible[] = [];
    for (const i of aGarder) {
      const v = await verifierFacturesAvantDepot(user, [fichiers[i]], { instances });
      if (!v.ok) refus.set(i, v.error);
      else marques.push(...v.probables.map((p) => p.marque));
    }
    return {
      refus,
      apres: async () => {
        for (const m of marques) await marquerDoublonPossible({ marque: m, legalDocumentId, ordreIds, demandeId, acteurId: user.id });
      },
    };
  } catch (err) {
    console.error("[factures] garde du dépôt libre indisponible (le dépôt continue)", err);
    return rien;
  }
}
