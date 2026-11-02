import * as XLSX from "xlsx";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { toNumber } from "@/lib/utils";
import { getMyCompanies } from "@/lib/company";
import { PAYMENT_REQUEST_STATUS, PAYMENT_URGENCY } from "@/lib/labels";
import { chargerCentre, fileAInstruire, instruitLesDemandes, myPaymentRequests } from "@/modules/finances/api";
import {
  CENTRAL_STATUS_LABEL, deadlineLabel, deadlineNatureLabel, isCompanionDossier, SECTION_CENTRE_LABEL, SECTION_CENTRE_SLUG, sortByPriority,
  type SectionCentre,
} from "@/modules/finances/partage";
import { cleParLibelle, libellesDe } from "./filtres";
import { exporte, MIME_XLSX, refusExport, type ResultatExport } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES EXPORTS DE L'ARGENT (Direction, 01/11/2026 : « l'export des demandes de paiement, oui. Enfin, l'export de tout »).
 *
 *   • LES DEMANDES DE PAIEMENT — ce que montre `/validations/paiements` : mes demandes (`myPaymentRequests`) et, pour
 *     qui instruit (`instruitLesDemandes`), la file à instruire (`fileAInstruire`) — les mêmes fonctions que la page,
 *     dans le même ordre (échéance réelle, `sortByPriority`).
 *   • LES ORDRES DU CENTRE DE PAIEMENT — ce que montre `/centre-de-paiement` : la portée du chargeur (`chargerCentre` :
 *     tout le centre pour qui y siège, ses propres demandes sinon, dans les sociétés de la personne), l'entité et la
 *     section choisies comme à l'écran — sans la coupe d'affichage (300 lignes).
 *
 * Partagés par les routes des boutons et par l'Assistant IA (lot K7, décision 0037) : même portée, mêmes droits, audit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const EXPORT_MAX = 5_000;
const jour = (d: Date | null | undefined): string => (d ? d.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" }) : "");

function classeur(feuilles: { nom: string; lignes: Record<string, unknown>[] }[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const f of feuilles) {
    const ws = XLSX.utils.json_to_sheet(f.lignes.length ? f.lignes : [{ "": "Aucune ligne" }]);
    ws["!cols"] = Object.keys(f.lignes[0] ?? { "": "" }).map((k) => ({ wch: Math.max(12, Math.min(48, k.length + 4)) }));
    XLSX.utils.book_append_sheet(wb, ws, f.nom.slice(0, 31));
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export interface OptionsExportDemandesPaiement {
  /** « miennes », « a_instruire » (Finances) ou toutes celles que l'écran montre (défaut). */
  perimetre?: string | null;
  /** Les états (clé ou libellé : « Mise en attente », « Chez les Finances »…). */
  statuts?: string[];
}

export async function exporterDemandesPaiement(user: CurrentUser, o: OptionsExportDemandesPaiement = {}): Promise<ResultatExport> {
  const statuts: string[] = [];
  for (const s of o.statuts ?? []) {
    const k = cleParLibelle(PAYMENT_REQUEST_STATUS, s);
    if (!k) return refusExport(400, `État « ${s} » inconnu — états : ${libellesDe(PAYMENT_REQUEST_STATUS)}.`);
    statuts.push(k);
  }
  const finance = instruitLesDemandes(user);
  const perimetre = o.perimetre === "miennes" || o.perimetre === "a_instruire" ? o.perimetre : "tout";
  if (perimetre === "a_instruire" && !finance) return refusExport(403, "La file à instruire est celle des Finances : votre rôle ne l'ouvre pas.");
  const [mine, queue] = await Promise.all([
    perimetre === "a_instruire" ? Promise.resolve([]) : myPaymentRequests(user.id, EXPORT_MAX),
    finance && perimetre !== "miennes" ? fileAInstruire(EXPORT_MAX) : Promise.resolve([]),
  ]);
  const garder = <T extends { status: string }>(rows: T[]) => (statuts.length ? rows.filter((r) => statuts.includes(r.status)) : rows);
  const entites = Object.fromEntries((await getMyCompanies(user.id)).map((c) => [c.id, c.shortName || c.name]));
  const noms = new Map((await prisma.user.findMany({
    where: { id: { in: [...new Set([...mine, ...queue].map((r) => r.requesterId))] } }, select: { id: true, name: true },
  })).map((u) => [u.id, u.name]));
  const ligne = (r: (typeof mine)[number]) => ({
    "Référence": r.reference,
    "Objet": r.title,
    "Bénéficiaire": r.payee ?? "",
    "Demandeur": noms.get(r.requesterId) ?? "",
    "Entité": r.companyId ? entites[r.companyId] ?? "" : "Sans entité",
    "Montant (DZD)": toNumber(r.amount),
    "Échéance": deadlineLabel(r, PAYMENT_URGENCY),
    "Nature de l'échéance": r.dueDate ? deadlineNatureLabel(r.deadlineNature) : "",
    "État": PAYMENT_REQUEST_STATUS[r.status]?.label ?? r.status,
    "Origine": isCompanionDossier(r.origin) ? "accompagne un ordre de dépense" : "demande de paiement",
    "Créée le": jour(r.createdAt),
  });
  const feuilles = [
    ...(perimetre !== "miennes" && finance ? [{ nom: "À instruire (Finances)", lignes: sortByPriority(garder(queue)).map(ligne) }] : []),
    ...(perimetre !== "a_instruire" ? [{ nom: "Mes demandes", lignes: sortByPriority(garder(mine)).map(ligne) }] : []),
  ];
  const n = feuilles.reduce((s, f) => s + f.lignes.length, 0);
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Finances", summary: `Export des demandes de paiement — ${feuilles.map((f) => `${f.nom} : ${f.lignes.length}`).join(" · ")}` });
  const date = new Date().toISOString().slice(0, 10);
  return exporte(classeur(feuilles), `demandes-de-paiement-${date}.xlsx`, MIME_XLSX,
    `${n} demande(s) de paiement (${feuilles.map((f) => `${f.nom} : ${f.lignes.length}`).join(", ")})${statuts.length ? ` — états : ${statuts.map((s) => PAYMENT_REQUEST_STATUS[s]?.label ?? s).join(", ")}` : ""}`);
}

export interface OptionsExportCentre {
  /** La société (identifiant, nom court ou nom) — par défaut celle que l'écran ouvre. */
  entite?: string | null;
  /** « REGULATORY », « SALES_MARKETING », « AUTRES », ou « toutes » (toute l'entité). Défaut : celle de l'écran. */
  section?: string | null;
  /** Les statuts du centre (clé ou libellé : « En attente », « Autorisé »…). */
  statuts?: string[];
}

export async function exporterOrdresCentre(user: CurrentUser, o: OptionsExportCentre = {}): Promise<ResultatExport> {
  const toutes = /^tout/i.test(o.section ?? "");
  // La section : le slug de l'adresse de l'écran (« sales-marketing »), sa clé ou son libellé (« Sales & Marketing »).
  const cle = !toutes && o.section ? cleParLibelle(SECTION_CENTRE_LABEL, o.section) as SectionCentre | undefined : undefined;
  const sectionCle = toutes || !o.section ? null : cle ? SECTION_CENTRE_SLUG[cle] : o.section;
  // L'ENTITÉ par son nom (l'assistant) : résolue parmi les sociétés de la personne, puis VALIDÉE par le chargeur.
  const mesSocietes = await getMyCompanies(user.id);
  const q = (o.entite ?? "").trim().toLowerCase();
  const entite = q ? (mesSocietes.find((c) => c.id === o.entite || (c.shortName ?? "").toLowerCase() === q || c.name.toLowerCase() === q || c.name.toLowerCase().includes(q))?.id ?? o.entite!) : null;
  const statuts: string[] = [];
  for (const s of o.statuts ?? []) {
    const k = cleParLibelle(CENTRAL_STATUS_LABEL, s);
    if (!k) return refusExport(400, `Statut « ${s} » inconnu — statuts : ${libellesDe(CENTRAL_STATUS_LABEL)}.`);
    statuts.push(k);
  }
  const centre = await chargerCentre(user, { entite, section: sectionCle });
  if (centre.aucunOrdre) return refusExport(404, "Aucun ordre au centre de paiement dans votre portée.");
  const ids = (toutes ? centre.idsEntite : centre.idsSection).slice(0, EXPORT_MAX);
  const lus = ids.length ? await prisma.expenseOrder.findMany({
    where: { id: { in: ids }, ...(statuts.length ? { centralStatus: { in: statuts } } : {}) },
    include: { requestedBy: { select: { name: true } }, company: { select: { name: true, shortName: true } } },
  }) : [];
  const rang = new Map(ids.map((id, i) => [id, i]));
  const ordres = lus.sort((a, b) => (rang.get(a.id) ?? 0) - (rang.get(b.id) ?? 0));
  const entiteLabel = centre.entites.find((e) => e.cle === centre.entiteChoisie)?.label ?? "";
  const sectionLabel = toutes ? "toutes sections" : SECTION_CENTRE_LABEL[centre.sectionChoisie];
  const lignes = ordres.map((r) => ({
    "Référence": r.reference,
    "Libellé": r.label,
    "Bénéficiaire": r.beneficiary ?? "",
    "Entité": r.company ? r.company.shortName || r.company.name : "Sans entité",
    "Montant (DZD)": toNumber(r.amount),
    "Statut du centre": CENTRAL_STATUS_LABEL[r.centralStatus as keyof typeof CENTRAL_STATUS_LABEL] ?? r.centralStatus,
    "Décidé le": jour(r.centralDecidedAt),
    "Échéance": jour(r.dueDate),
    "Demandé par": r.requestedBy?.name ?? "",
    "Payé le": jour(r.paidDate),
    "Créé le": jour(r.createdAt),
  }));
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Centre de paiement", summary: `Export du centre de paiement — ${entiteLabel}, ${sectionLabel} : ${lignes.length} ordre(s)` });
  const nom = `centre-de-paiement-${entiteLabel}-${sectionLabel}`.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase();
  return exporte(classeur([{ nom: "Ordres", lignes }]), `${nom}-${new Date().toISOString().slice(0, 10)}.xlsx`, MIME_XLSX,
    `${lignes.length} ordre(s) du centre de paiement — ${entiteLabel}, ${sectionLabel}${statuts.length ? ` — statuts : ${statuts.map((s) => CENTRAL_STATUS_LABEL[s as keyof typeof CENTRAL_STATUS_LABEL] ?? s).join(", ")}` : ""}`);
}
