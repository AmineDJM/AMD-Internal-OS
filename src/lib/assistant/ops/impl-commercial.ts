import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { decideAdProItem } from "@/modules/ad-pro/actions-postes-decision";
import { transferAdProRequest } from "@/modules/ad-pro/actions-transfert";
import { validatePromoStep, refusePromoStep } from "@/lib/actions/promo-circuit-actions";
import { createBD, updateBDStatus } from "@/lib/actions/bd-actions";
import { requestStockState } from "@/lib/actions/stock-snapshot-actions";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";
import { designerDossierPromo } from "@/platform/in-process/promo";

/**
 * OPS COMMERCIALES — la longue traîne Ad & Pro (postes de dépense, transferts entre modules,
 * circuit du matériel promotionnel), le pipeline Business Development et les états de stock
 * hôpitaux, par les ACTIONS CANONIQUES. Les portes de fond (Direction pour les postes,
 * étape courante pour le circuit promo) restent celles des actions.
 */

const dzd = (n: number): string => `${n.toLocaleString("fr-FR")} DZD`;

function amountOf(input: Record<string, unknown>, key: string): number | null {
  const v = input[key];
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  const n = Number(s.replace(/[\s ]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

type AdProKind = "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL";
const ADPRO_FR: Record<AdProKind, string> = {
  SPONSORING: "Sponsoring",
  CONGRESS_NATIONAL: "Prise en charge Nationale",
  CONGRESS_INTERNATIONAL: "Prise en charge Internationale",
};

function adproKindOf(raw: string): AdProKind | null {
  const k = raw.toLowerCase();
  if (/sponsoring/.test(k)) return "SPONSORING";
  if (/international/.test(k)) return "CONGRESS_INTERNATIONAL";
  if (/national|congr[èe]s/.test(k)) return "CONGRESS_NATIONAL";
  return null;
}

/** La demande Ad & Pro SOURCE d'un transfert — référence de sponsoring, ou NOM d'événement
 *  (les prises en charge n'ont pas de référence : leur nom fait foi). Ambigu = listé. */
async function findAdProSource(raw: string): Promise<{ kind: AdProKind; id: string; title: string; display: string } | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez la référence du sponsoring (SPO-…) ou le nom de l'événement (champ « reference »)." };
  const hits: { kind: AdProKind; id: string; title: string; display: string }[] = [];
  const spons = await prisma.sponsoringRequest.findMany({
    where: { OR: [{ reference: { equals: q, mode: "insensitive" } }, { institution: { contains: q, mode: "insensitive" } }] },
    select: { id: true, reference: true, institution: true },
    take: 4,
  });
  for (const s of spons) hits.push({ kind: "SPONSORING", id: s.id, title: s.institution, display: `${s.reference} — ${s.institution}` });
  const nat = await prisma.congressNational.findMany({
    where: { name: { contains: q, mode: "insensitive" } },
    select: { id: true, name: true },
    take: 4,
  });
  for (const n of nat) hits.push({ kind: "CONGRESS_NATIONAL", id: n.id, title: n.name, display: `${n.name} (${ADPRO_FR.CONGRESS_NATIONAL})` });
  const intl = await prisma.congressInternational.findMany({
    where: { name: { contains: q, mode: "insensitive" } },
    select: { id: true, name: true },
    take: 4,
  });
  for (const i of intl) hits.push({ kind: "CONGRESS_INTERNATIONAL", id: i.id, title: i.name, display: `${i.name} (${ADPRO_FR.CONGRESS_INTERNATIONAL})` });
  if (hits.length === 0) return { error: `Aucune demande Ad & Pro « ${q} » (référence de sponsoring ou nom d'événement).` };
  if (hits.length > 1) return { error: `Plusieurs demandes correspondent à « ${q} » : ${hits.map((h) => h.display).join(" ; ")} — préciser.` };
  return hits[0];
}

/**
 * LE DOSSIER DONT ON VALIDE OU REFUSE L'ÉTAPE — désigné sous la porte de la FICHE (§118.152), et
 * nommé dans le vocabulaire de SON circuit : un dossier du circuit 2 n'a pas les étapes de celui
 * d'avant, et la carte qu'on confirme doit dire l'étape que l'écran affiche.
 */
async function resolvePromoDossier(user: Parameters<OpImpl["propose"]>[1], raw: string): Promise<{ id: string; reference: string; title: string; etape: string } | { error: string }> {
  const d = await designerDossierPromo(user, raw);
  if ("error" in d) return d;
  if (!d.circuitState || !d.etape) return { error: `Le circuit n'est pas lancé sur ${d.reference}.` };
  return { id: d.id, reference: d.reference, title: d.title, etape: d.etape };
}

const BD_STATUS_FR: Record<string, string> = {
  IDEA: "Idée", RESEARCH: "Recherche", CONTACTED: "Contacté", NDA: "NDA",
  OFFER_RECEIVED: "Offre reçue", NEGOTIATION: "Négociation", VALIDATED: "Validée", ABANDONED: "Abandonnée",
};

function bdStatusOf(raw: string): string | null {
  const k = raw.toLowerCase();
  if (/id[ée]e/.test(k)) return "IDEA";
  if (/recherche/.test(k)) return "RESEARCH";
  if (/contact/.test(k)) return "CONTACTED";
  if (/nda|confidentialit/.test(k)) return "NDA";
  if (/offre/.test(k)) return "OFFER_RECEIVED";
  if (/n[ée]goci/.test(k)) return "NEGOTIATION";
  if (/valid/.test(k)) return "VALIDATED";
  if (/abandon/.test(k)) return "ABANDONED";
  return null;
}

export const ADPRO_OPS_IMPL: Record<string, OpImpl> = {
  decide_item: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const raw = opStr(input, "decision").toLowerCase();
      const decision = /revoir|revision|budget/.test(raw) ? "REVISION" : /accord|approuv|valide/.test(raw) ? "APPROVED" : /refus|rejet/.test(raw) ? "REJECTED" : null;
      if (!decision) return { error: "Précisez la décision : accorder, refuser, ou budget à revoir (champ « decision »)." };
      const q = opStr(input, "label");
      const rows = await prisma.adProItem.findMany({
        where: {
          status: "PENDING",
          ...(q ? { label: { contains: q, mode: "insensitive" } } : {}),
        },
        select: {
          id: true, label: true, amountEstimated: true, supplier: true,
          sponsoring: { select: { reference: true } },
          congressNational: { select: { name: true } },
          congressInternational: { select: { name: true } },
          event: { select: { name: true } },
          training: { select: { reference: true } },
        },
        orderBy: { submittedAt: "desc" },
        take: 6,
      });
      if (rows.length === 0) return { error: `Aucun poste de dépense SOUMIS${q ? ` correspondant à « ${q} »` : ""}.` };
      const parentRef = (r: (typeof rows)[number]): string =>
        r.sponsoring?.reference ?? r.congressNational?.name ?? r.congressInternational?.name ?? r.event?.name ?? r.training?.reference ?? "—";
      if (rows.length > 1) {
        return { error: `Plusieurs postes soumis : ${rows.map((r) => `« ${r.label} » (${parentRef(r)}${r.amountEstimated !== null ? `, ${dzd(toNumber(r.amountEstimated))}` : ""})`).join(" ; ")} — préciser le libellé.` };
      }
      const item = rows[0];
      const estimated = item.amountEstimated !== null ? toNumber(item.amountEstimated) : null;
      const granted = decision === "APPROVED" ? (amountOf(input, "amount") ?? estimated) : null;
      const DECISION_FR: Record<string, string> = { APPROVED: "Accordé", REJECTED: "Refusé", REVISION: "Budget à revoir" };
      return {
        title: `${DECISION_FR[decision]} — poste « ${item.label} » (${parentRef(item)})`,
        fields: [
          { label: "Poste", value: `${item.label} — ${parentRef(item)}` },
          ...(item.supplier ? [{ label: "Bénéficiaire", value: item.supplier }] : []),
          ...(estimated !== null ? [{ label: "Montant estimé", value: dzd(estimated) }] : []),
          { label: "Décision", value: decision === "APPROVED" && granted !== null ? `Accordé — ${dzd(granted)}` : DECISION_FR[decision] },
        ],
        warnings: ["Décision de la DIRECTION sur le poste — le demandeur est notifié. Un poste dont le bon de commande est émis ne se redécide plus."],
        args: { id: item.id, decision, amountGranted: granted !== null ? String(granted) : null, note: opStr(input, "note"), label: item.label },
        successMessage: `Poste « ${item.label} » : ${DECISION_FR[decision].toLowerCase()}${granted !== null && decision === "APPROVED" ? ` (${dzd(granted)})` : ""}.`,
        revalidate: ["/sponsoring"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("decision", args.decision ?? "");
      if (args.amountGranted) fd.set("amountGranted", args.amountGranted);
      if (args.note) fd.set("note", args.note);
      const r = await decideAdProItem(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La décision sur le poste a été refusée." };
      return { ok: true, revalidate: ["/sponsoring"] };
    },
  },

  transfer: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const src = await findAdProSource(opStr(input, "reference"));
      if ("error" in src) return src;
      const to = adproKindOf(opStr(input, "to"));
      if (!to) return { error: "Précisez le module de destination (champ « to ») : sponsoring, prise en charge nationale ou internationale." };
      if (to === src.kind) return { error: `La demande « ${src.title} » est déjà en ${ADPRO_FR[src.kind]}.` };
      return {
        title: `Transférer « ${src.title} » : ${ADPRO_FR[src.kind]} → ${ADPRO_FR[to]}`,
        fields: [
          { label: "Demande", value: src.display },
          { label: "Transfert", value: `${ADPRO_FR[src.kind]} → ${ADPRO_FR[to]}` },
        ],
        warnings: [
          "Les pièces suivent ; l'ancien circuit est CLOS ; le circuit de la destination repart du DÉBUT.",
          "Refusé si un ordre de dépense a déjà été émis sur la demande.",
        ],
        args: { from: src.kind, to, sourceId: src.id, reference: src.display },
        successMessage: `« ${src.title} » transférée vers ${ADPRO_FR[to]} — le circuit repart du début.`,
        revalidate: ["/sponsoring"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("from", args.from ?? "");
      fd.set("to", args.to ?? "");
      fd.set("sourceId", args.sourceId ?? "");
      const r = await transferAdProRequest(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le transfert a été refusé." };
      return { ok: true, revalidate: ["/sponsoring"] };
    },
  },

  validate_promo_step: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const dossier = await resolvePromoDossier(user, opStr(input, "reference") || opStr(input, "label"));
      if ("error" in dossier) return dossier;
      return {
        title: `Valider l'étape « ${dossier.etape} » — ${dossier.reference}`,
        fields: [
          { label: "Dossier", value: `${dossier.reference} — ${dossier.title}` },
          { label: "Étape courante", value: dossier.etape },
        ],
        warnings: ["L'étape décide qui peut valider : si elle ne vous revient pas, l'exécution refusera en le disant. La personne de l'étape suivante est notifiée."],
        args: { id: dossier.id, reference: dossier.reference },
        successMessage: `Étape « ${dossier.etape} » validée sur ${dossier.reference}.`,
        revalidate: ["/promo-material"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      const r = await validatePromoStep(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La validation de l'étape a été refusée." };
      return { ok: true, revalidate: ["/promo-material"] };
    },
  },

  refuse_promo_step: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const reason = opStr(input, "note");
      if (!reason) return { error: "Donnez le motif du refus (champ « note ») — un refus sans motif ne dit pas quoi corriger." };
      const dossier = await resolvePromoDossier(user, opStr(input, "reference") || opStr(input, "label"));
      if ("error" in dossier) return dossier;
      return {
        title: `Refuser l'étape « ${dossier.etape} » — ${dossier.reference}`,
        fields: [
          { label: "Dossier", value: `${dossier.reference} — ${dossier.title}` },
          { label: "Étape courante", value: dossier.etape },
          { label: "Motif", value: reason },
        ],
        warnings: ["Le dossier revient en arrière ; le demandeur est notifié avec le motif."],
        args: { id: dossier.id, reason, reference: dossier.reference },
        successMessage: `Étape refusée sur ${dossier.reference} — le demandeur est prévenu.`,
        revalidate: ["/promo-material"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("reason", args.reason ?? "");
      const r = await refusePromoStep(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le refus de l'étape a été refusé." };
      return { ok: true, revalidate: ["/promo-material"] };
    },
  },
};

export const BD_OPS_IMPL: Record<string, OpImpl> = {
  create: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const name = opStr(input, "name");
      if (!name) return { error: "Donnez le nom de l'opportunité (champ « name »)." };
      const dci = opStr(input, "dci");
      return {
        title: `Créer l'opportunité BD « ${name} »`,
        fields: [
          { label: "Opportunité", value: name },
          ...(dci ? [{ label: "DCI", value: dci }] : []),
          { label: "Stade de départ", value: "Idée" },
        ],
        args: { name, dci, therapeuticClass: opStr(input, "therapeuticClass") },
        successMessage: `Opportunité BD « ${name} » créée (stade Idée).`,
        revalidate: ["/business-development"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("name", args.name ?? "");
      if (args.dci) fd.set("dci", args.dci);
      if (args.therapeuticClass) fd.set("therapeuticClass", args.therapeuticClass);
      const r = await createBD(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La création de l'opportunité a été refusée." };
      return { ok: true, createdId: r.id, revalidate: ["/business-development"] };
    },
  },

  update_status: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const status = bdStatusOf(opStr(input, "status"));
      if (!status) return { error: `Précisez le stade visé (champ « status ») : ${Object.values(BD_STATUS_FR).join(", ")}.` };
      const q = opStr(input, "name");
      if (!q) return { error: "Précisez le nom de l'opportunité BD (champ « name »)." };
      const rows = await prisma.businessDevelopmentOpportunity.findMany({
        where: { name: { contains: q, mode: "insensitive" } },
        select: { id: true, name: true, status: true },
        orderBy: { updatedAt: "desc" },
        take: 6,
      });
      if (rows.length === 0) return { error: `Aucune opportunité BD « ${q} ».` };
      if (rows.length > 1 && !rows.some((r) => r.name.toLowerCase() === q.toLowerCase())) {
        return { error: `Plusieurs opportunités correspondent à « ${q} » : ${rows.map((r) => r.name).join(" ; ")} — préciser.` };
      }
      const bd = rows.find((r) => r.name.toLowerCase() === q.toLowerCase()) ?? rows[0];
      if (bd.status === status) return { error: `« ${bd.name} » est déjà au stade ${BD_STATUS_FR[status]}.` };
      return {
        title: `Opportunité « ${bd.name} » → ${BD_STATUS_FR[status]}`,
        fields: [
          { label: "Opportunité", value: bd.name },
          { label: "Stade", value: `${BD_STATUS_FR[bd.status] ?? bd.status} → ${BD_STATUS_FR[status]}` },
        ],
        args: { id: bd.id, status, name: bd.name },
        successMessage: `« ${bd.name} » passée au stade ${BD_STATUS_FR[status]}.`,
        revalidate: ["/business-development"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("status", args.status ?? "");
      const r = await updateBDStatus(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le changement de stade a été refusé." };
      return { ok: true, revalidate: ["/business-development"] };
    },
  },
};

export const STOCK_OPS_IMPL: Record<string, OpImpl> = {
  request_state: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const who = opStr(input, "assigneeName");
      if (!who) return { error: "Précisez à qui demander l'état de stock (champ « assigneeName »)." };
      const people = await prisma.user.findMany({
        where: { name: { contains: who, mode: "insensitive" }, isActive: true },
        select: { id: true, name: true },
        take: 4,
      });
      if (people.length === 0) return { error: `« ${who} » introuvable dans l'annuaire.` };
      if (people.length > 1) return { error: `Plusieurs « ${who} » : ${people.map((p) => p.name).join(", ")} — préciser.` };
      const assignee = people[0];
      const hospitalsRaw = opStr(input, "hospitals");
      const hospitals: { id: string; name: string }[] = [];
      if (hospitalsRaw) {
        for (const h of hospitalsRaw.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
          const found = await prisma.stockAnnex.findMany({
            where: { name: { contains: h, mode: "insensitive" }, kind: { not: "ANNEX" } },
            select: { id: true, name: true },
            take: 3,
          });
          if (found.length === 0) return { error: `Hôpital « ${h} » introuvable dans les lieux de stock.` };
          if (found.length > 1) return { error: `Plusieurs hôpitaux correspondent à « ${h} » : ${found.map((f) => f.name).join(", ")} — préciser.` };
          hospitals.push(found[0]);
        }
      }
      return {
        title: `Demander un état de stock à ${assignee.name}`,
        fields: [
          { label: "Demandé à", value: assignee.name },
          { label: "Hôpitaux", value: hospitals.length ? hospitals.map((h) => h.name).join(", ") : "tous / à l'appréciation du destinataire" },
          ...(opStr(input, "note") ? [{ label: "Précision", value: opStr(input, "note") }] : []),
        ],
        warnings: [`${assignee.name} reçoit une DEMANDE DE TÂCHE (accepter/refuser) — le circuit normal.`],
        args: { assigneeId: assignee.id, assigneeName: assignee.name, hospitalIds: hospitals.map((h) => h.id).join(","), note: opStr(input, "note") },
        successMessage: `État de stock demandé à ${assignee.name}.`,
        revalidate: ["/stocks"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("assigneeId", args.assigneeId ?? "");
      if (args.note) fd.set("note", args.note);
      for (const id of (args.hospitalIds ?? "").split(",").filter(Boolean)) fd.append("hospitalIds", id);
      const r = await requestStockState(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La demande d'état de stock a été refusée." };
      return { ok: true, revalidate: ["/stocks"] };
    },
  },
};
