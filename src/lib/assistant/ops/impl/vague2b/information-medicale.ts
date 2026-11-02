/**
 * OPS VAGUE 2b — INFORMATION MÉDICALE : déclarations aux autorités et leurs bordereaux, par les
 * actions canoniques.
 */
import { prisma } from "./erp";
import { toNumber } from "@/lib/utils";
import { requestDocument as requestMedicalDoc, cancelDocRequest, recordAuthorityDeclaration, validateDeclaration, validateDeclarationByDirection, addMedicalInfoComment, requestSlipsValidation, requestSlipPayment, deliverMedicalInfoSlip, skipMedicalInfoBv, requestDeclareDecision, addMedicalInfoSlip, removeMedicalInfoSlip, createMedicalInfoItem } from "@/lib/actions/medical-info-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, dzd, fieldsOf, isoDate } from "../../helpers";
import { resolvePerson } from "./commun";

// ─────────────── Information médicale ───────────────

const MEDINFO_STATUS_FR: Record<string, string> = {
  AWAITING_REVIEW: "En attente de revue", DOCS_REQUESTED: "Pièces demandées", READY: "Prête",
  AWAITING_DIRECTION: "En attente du Directeur des Opérations", VALIDATED: "Validée",
};

async function resolveDeclaration(raw: string, statuses?: string[]) {
  const q = raw.trim();
  if (!q) return { error: "Précisez la référence ou le libellé de la déclaration (champ « reference »)." } as const;
  const rows = await prisma.medicalInfoDeclaration.findMany({
    where: {
      ...(statuses ? { status: { in: statuses as never } } : {}),
      OR: [{ reference: { equals: q, mode: "insensitive" } }, { label: { contains: q, mode: "insensitive" } }, { beneficiary: { contains: q, mode: "insensitive" } }],
    },
    select: { id: true, reference: true, label: true, beneficiary: true, status: true, amount: true },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  if (rows.length === 0) return { error: `Aucune déclaration « ${q} ».` } as const;
  const exact = rows.filter((r) => r.reference.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  return { error: `Plusieurs déclarations correspondent à « ${q} » : ${rows.map((r) => `${r.reference} — ${r.label} (${MEDINFO_STATUS_FR[r.status] ?? r.status})`).join(" ; ")} — donner la référence exacte.` } as const;
}

/**
 * UN MATÉRIEL DANS UN DOSSIER — le bon de versement se demande MATÉRIEL PAR MATÉRIEL.
 *
 * Une cible ambiguë rend des CANDIDATS, jamais « le premier des quatre » : faire payer la
 * quittance du mauvais matériel en annonçant que c'est fait est le défaut le plus coûteux de tout
 * ce circuit.
 */
async function resolveSlip(declarationId: string, raw: string) {
  const rows = await prisma.medicalInfoSlip.findMany({
    where: { declarationId },
    select: { id: true, label: true, amount: true, requestId: true, deliveredAt: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  if (rows.length === 0) return { error: "Ce dossier n'a encore aucun matériel : séparez-le d'abord en matériels." } as const;
  const q = raw.trim().toLowerCase();
  if (!q) {
    if (rows.length === 1) return rows[0];
    return { error: `Ce dossier porte ${rows.length} matériels : ${rows.map((r) => r.label).join(" ; ")} — préciser lequel (champ « material »).` } as const;
  }
  const hits = rows.filter((r) => r.label.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return { error: `Aucun matériel « ${raw} » dans ce dossier : ${rows.map((r) => r.label).join(" ; ")}.` } as const;
  return { error: `Plusieurs matériels correspondent à « ${raw} » : ${hits.map((r) => r.label).join(" ; ")} — préciser.` } as const;
}

export const MEDINFO_OPS_IMPL: Record<string, OpImpl> = {
  request_declaration_document: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const label = opStr(input, "piece") || opStr(input, "label");
      if (!label) return { error: "Précisez la pièce demandée (champ « piece »)." };
      const person = await resolvePerson(opStr(input, "person"));
      if ("error" in person) return person;
      return {
        title: `Demander « ${label} » sur la déclaration ${decl.reference}`,
        fields: [
          { label: "Déclaration", value: `${decl.reference} — ${decl.label}` },
          { label: "Pièce", value: label },
          { label: "À", value: person.name },
        ],
        warnings: ["La déclaration passe « Pièces demandées » jusqu'à réception."],
        args: { declarationId: decl.id, label, targetUserId: person.id },
        successMessage: `Pièce « ${label} » demandée à ${person.name} (${decl.reference}).`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(requestMedicalDoc, args, "La demande de pièce a été refusée.", { revalidate: ["/information-medicale"] }),
  },

  cancel_declaration_document: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const open = await prisma.medicalInfoDocRequest.findMany({
        where: { declarationId: decl.id, status: "PENDING", ...(opStr(input, "piece") ? { label: { contains: opStr(input, "piece"), mode: "insensitive" } } : {}) },
        select: { id: true, label: true }, take: 6,
      });
      if (open.length === 0) return { error: `Aucune demande de pièce EN ATTENTE sur ${decl.reference}.` };
      if (open.length > 1) return { error: `Plusieurs pièces en attente : ${open.map((o) => o.label).join(", ")} — préciser (champ « piece »).` };
      return {
        title: `Annuler la demande de pièce « ${open[0].label} » (${decl.reference})`,
        fields: [{ label: "Pièce", value: `${open[0].label} — ${decl.reference}` }],
        args: { id: open[0].id },
        successMessage: `Demande de pièce « ${open[0].label} » annulée.`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(cancelDocRequest, args, "L'annulation a été refusée.", { revalidate: ["/information-medicale"] }),
  },

  // ─────── CIRCUIT ÉVÉNEMENT — « faut-il déclarer ? », sans aucun versement ───────

  declare_decision: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const brut = (opStr(input, "intent") || "").toLowerCase();
      const intent = /^(skip|non|sans|pas)/.test(brut) ? "SKIP" : /^(declare|déclare|oui)/.test(brut) ? "DECLARE" : null;
      if (!intent) return { error: "Dites ce qui est soumis : « declare » (à déclarer au ministère) ou « skip » (sans déclaration) — champ « intent »." };
      const note = opStr(input, "note");
      if (intent === "SKIP" && !note) {
        return { error: "Une lecture « sans déclaration » exige un motif (champ « note ») : c'est ce que lira le validateur, puis l'audit." };
      }
      return {
        title: `${intent === "DECLARE" ? "À déclarer au ministère" : "Sans déclaration"} — ${decl.reference}`,
        fields: fieldsOf([
          ["Déclaration", `${decl.reference} — ${decl.label}`],
          ["Lecture soumise", intent === "DECLARE" ? "À déclarer au ministère" : "Sans déclaration"],
          ["Motif / note", note || null],
        ]),
        warnings: [
          "Ce dossier n'appelle AUCUN bon de versement : c'est le circuit des événements et prises en charge.",
          "Ce qu'on fait valider est la LECTURE du pharmacien, pas la question — le responsable, la Direction Marketing, puis le centre de validations.",
        ],
        args: { id: decl.id, intent, note: note || null },
        successMessage: `Lecture soumise à validation pour ${decl.reference}.`,
        link: `/information-medicale/${decl.id}`,
        revalidate: ["/information-medicale", "/validations", "/centre-de-validations"],
      };
    },
    execute: (args) => runFd2(requestDeclareDecision, args, "La demande de décision a été refusée.", {
      revalidate: ["/information-medicale", "/validations", "/centre-de-validations"],
    }),
  },

  // ─────── CIRCUIT MATÉRIEL — un bon de versement par matériel ───────

  add_slip: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const label = opStr(input, "material") || opStr(input, "title");
      if (!label) return { error: "Nommez le matériel concerné par ce bon (champ « material »)." };
      const raw = opStr(input, "amount");
      const montant = raw ? Number(raw.replace(",", ".").replace(/\s/g, "")) : null;
      if (raw && (!Number.isFinite(montant) || (montant ?? 0) < 0)) return { error: "Montant du bon invalide." };
      return {
        title: `Ajouter un matériel — ${label} (${decl.reference})`,
        fields: fieldsOf([
          ["Déclaration", `${decl.reference} — ${decl.label}`],
          ["Matériel", label],
          ["Montant annoncé", montant ? dzd(montant) : null],
          ["Note", opStr(input, "note") || null],
        ]),
        warnings: ["Un bon de versement PAR MATÉRIEL : la liste se fige dès que son dépôt part en validation."],
        args: { declarationId: decl.id, label, amount: montant ? String(montant) : null, note: opStr(input, "note") || null },
        successMessage: `Matériel « ${label} » ajouté à ${decl.reference}.`,
        link: `/information-medicale/${decl.id}`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd2(addMedicalInfoSlip, args, "L'ajout du matériel a été refusé.", { revalidate: ["/information-medicale"] }),
  },

  remove_slip: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const slip = await resolveSlip(decl.id, opStr(input, "material"));
      if ("error" in slip) return slip;
      return {
        title: `Retirer le matériel « ${slip.label} » — ${decl.reference}`,
        fields: fieldsOf([["Déclaration", `${decl.reference} — ${decl.label}`], ["Matériel", slip.label]]),
        warnings: ["Impossible une fois le dépôt soumis à validation : la signature porterait sur autre chose que ce qui existe."],
        args: { slipId: slip.id },
        successMessage: `Matériel « ${slip.label} » retiré de ${decl.reference}.`,
        link: `/information-medicale/${decl.id}`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(removeMedicalInfoSlip, args, "Le retrait du matériel a été refusé.", { revalidate: ["/information-medicale"] }),
  },

  request_bv: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const slips = await prisma.medicalInfoSlip.findMany({
        where: { declarationId: decl.id }, select: { label: true, amount: true },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      });
      if (slips.length === 0) {
        return { error: "Ce dossier n'a encore aucun matériel : séparez-le d'abord (op « add_slip »). Faire signer une liste vide, c'est faire signer une intention." };
      }
      const total = slips.reduce((a, sl) => a + (sl.amount ? Number(sl.amount) : 0), 0);
      return {
        title: `Faire valider le dépôt de ${slips.length} bon(s) — ${decl.reference}`,
        fields: fieldsOf([
          ["Déclaration", `${decl.reference} — ${decl.label}`],
          ["Matériels", slips.map((sl) => sl.label).join(" · ")],
          ["Total annoncé", total > 0 ? dzd(total) : null],
          ["Note", opStr(input, "note") || null],
        ]),
        warnings: [
          "AUCUN ARGENT N'EST ENGAGÉ ICI : le dépôt part en VALIDATION — le responsable du pharmacien, le référent Direction Marketing du dossier, puis le centre de validations.",
          "Une seule validation pour le LOT ; le paiement de chaque quittance se demande ensuite SÉPARÉMENT.",
          "La liste des matériels est FIGÉE à partir de cet envoi.",
        ],
        args: { id: decl.id, note: opStr(input, "note") || null },
        successMessage: `Dépôt de ${slips.length} bon(s) soumis à validation pour ${decl.reference}.`,
        link: `/information-medicale/${decl.id}`,
        revalidate: ["/information-medicale", "/validations", "/centre-de-validations"],
      };
    },
    execute: (args) => runFd2(requestSlipsValidation, args, "La demande de validation a été refusée.", {
      revalidate: ["/information-medicale", "/validations", "/centre-de-validations"],
    }),
  },

  /**
   * LE SECOND TEMPS — la quittance, BON PAR BON. Elle ne peut être demandée qu'une fois le dépôt
   * accordé, et l'action le REVÉRIFIE : ce n'est pas à l'aperçu de garder cette garde.
   */
  request_quittance: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const slip = await resolveSlip(decl.id, opStr(input, "material"));
      if ("error" in slip) return slip;
      const montant = Number(opStr(input, "amount") ?? "");
      if (!Number.isFinite(montant) || montant <= 0) return { error: "Indiquez le montant de la quittance (champ « amount »)." };
      return {
        title: `Demander le paiement de la quittance — ${slip.label} (${decl.reference})`,
        fields: fieldsOf([
          ["Déclaration", `${decl.reference} — ${decl.label}`],
          ["Matériel", slip.label],
          ["Montant de la quittance", dzd(montant)],
          ["Bon annoncé", slip.amount ? dzd(Number(slip.amount)) : null],
          ["Bénéficiaire", opStr(input, "person") || "Autorités sanitaires"],
          ["Échéance demandée", isoDate(opStr(input, "date")) || null],
          ["Note", opStr(input, "note") || null],
        ]),
        warnings: [
          "Le dépôt des bons doit être ACCORDÉ : sans cela, l'action refuse.",
          "La demande part au CENTRE DE PAIEMENT ; les Finances ne la voient qu'une fois autorisée.",
          "Les pièces se joignent à l'écran : une demande de paiement se justifie par un document, pas par une phrase.",
        ],
        args: {
          slipId: slip.id, amount: String(montant),
          payee: opStr(input, "person") || "Autorités sanitaires",
          dueDate: isoDate(opStr(input, "date")) || null,
          note: opStr(input, "note") || null,
        },
        successMessage: `Quittance de ${dzd(montant)} demandée au paiement pour « ${slip.label} » — au centre de paiement.`,
        link: `/information-medicale/${decl.id}`,
        revalidate: ["/information-medicale", "/validations/paiements"],
      };
    },
    execute: (args) => runFd2(requestSlipPayment, args, "La demande de paiement a été refusée.", {
      revalidate: ["/information-medicale", "/validations/paiements"],
    }),
  },

  deliver_bv: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const slip = await resolveSlip(decl.id, opStr(input, "material"));
      if ("error" in slip) return slip;
      return {
        title: `Quittance remise au bureau du PRIM — ${slip.label} (${decl.reference})`,
        fields: fieldsOf([
          ["Déclaration", `${decl.reference} — ${decl.label}`],
          ["Matériel", slip.label],
          ["Note de remise", opStr(input, "note") || null],
        ]),
        warnings: ["C'est cette remise — et non le règlement — qui fait avancer le dossier ; la déclaration s'ouvre quand TOUTES les quittances sont remises."],
        args: { slipId: slip.id, note: opStr(input, "note") || null },
        successMessage: `Quittance de « ${slip.label} » remise au bureau du PRIM.`,
        link: `/information-medicale/${decl.id}`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(deliverMedicalInfoSlip, args, "La remise de la quittance a été refusée.", { revalidate: ["/information-medicale"] }),
  },

  skip_bv: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const motif = opStr(input, "note");
      if (!motif) return { error: "Dites POURQUOI ce dossier n'appelle aucun versement (champ « note ») : c'est ce que lira l'audit." };
      return {
        title: `Déclarer ${decl.reference} sans bon de versement`,
        fields: fieldsOf([["Déclaration", `${decl.reference} — ${decl.label}`], ["Motif", motif]]),
        warnings: [
          "Réservé au MATÉRIEL PROMOTIONNEL : les événements et prises en charge n'appellent aucun versement, et n'ont donc rien à contourner.",
          "Ouvre la déclaration aux autorités sans versement — le motif est versé au journal.",
        ],
        args: { id: decl.id, reason: motif },
        successMessage: `${decl.reference} déclarée sans versement — la déclaration aux autorités est ouverte.`,
        link: `/information-medicale/${decl.id}`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(skipMedicalInfoBv, args, "La déclaration « sans versement » a été refusée.", { revalidate: ["/information-medicale"] }),
  },

  // ─────── CE QUE LE PRIM OUVRE LUI-MÊME ───────

  create_medical_info_item: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const label = opStr(input, "label") || opStr(input, "title");
      if (!label) return { error: "Nommez ce qui est ouvert (champ « label »)." };
      const brut = (opStr(input, "kind") || "").toLowerCase();
      const kind = /visa/.test(brut) ? "AD_VISA"
        : /(bon|versement|bv|slip)/.test(brut) ? "PAYMENT_SLIP"
        : /(mip|minist|décl|decl)/.test(brut) ? "MIP"
        : null;
      if (!kind) return { error: "Choisissez la nature (champ « kind ») : « mip » (déclaration au ministère), « visa » (visa publicitaire) ou « bon de versement »." };
      const raw = opStr(input, "amount");
      const montant = raw ? Number(raw.replace(",", ".").replace(/\s/g, "")) : null;
      if (raw && (!Number.isFinite(montant) || (montant ?? 0) < 0)) return { error: "Montant invalide." };
      const NATURE: Record<string, string> = {
        MIP: "Déclaration au ministère (MIP)", AD_VISA: "Demande de visa publicitaire", PAYMENT_SLIP: "Bon de versement",
      };
      return {
        title: `Ouvrir — ${NATURE[kind]} : ${label}`,
        fields: fieldsOf([
          ["Objet", label], ["Nature", NATURE[kind]],
          ["Bénéficiaire", opStr(input, "person") || null],
          ["Montant", montant ? dzd(montant) : null],
        ]),
        warnings: [
          kind === "MIP"
            ? "Circuit ÉVÉNEMENT : la décision de déclarer se fait valider, puis le dépôt au ministère."
            : "Circuit MATÉRIEL : le dossier se sépare en matériels, un bon de versement par matériel.",
        ],
        args: { label, kind, beneficiary: opStr(input, "person") || null, amount: montant ? String(montant) : null },
        successMessage: `${NATURE[kind]} ouverte — ${label}.`,
        link: "/information-medicale",
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd2(createMedicalInfoItem, args, "L'ouverture du dossier a été refusée.", { revalidate: ["/information-medicale"] }),
  },

  record_authority_declaration: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const authorityRef = opStr(input, "authorityRef") || opStr(input, "note");
      if (!authorityRef) return { error: "Précisez la référence donnée par l'autorité (champ « authorityRef »)." };
      return {
        title: `Consigner la déclaration à l'autorité — ${decl.reference}`,
        fields: fieldsOf([
          ["Déclaration", `${decl.reference} — ${decl.label}`],
          ["Référence autorité", authorityRef],
          ["Notes", opStr(input, "notes") || null],
        ]),
        args: { id: decl.id, authorityRef, authorityNotes: opStr(input, "notes") || null },
        successMessage: `Référence autorité consignée sur ${decl.reference}.`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(recordAuthorityDeclaration, args, "L'enregistrement a été refusé.", { revalidate: ["/information-medicale"] }),
  },

  validate_declaration: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"), ["AWAITING_REVIEW", "DOCS_REQUESTED", "READY"]);
      if ("error" in decl) return decl;
      return {
        title: `Valider la déclaration ${decl.reference} (pharmacien)`,
        fields: [
          { label: "Déclaration", value: `${decl.reference} — ${decl.label}` },
          ...(decl.amount !== null ? [{ label: "Montant", value: dzd(toNumber(decl.amount)) }] : []),
        ],
        warnings: ["Validation PHARMACIEN : la déclaration monte ensuite au Directeur des Opérations."],
        args: { id: decl.id },
        successMessage: `Déclaration ${decl.reference} validée (pharmacien).`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(validateDeclaration, args, "La validation a été refusée.", { revalidate: ["/information-medicale"] }),
  },

  validate_declaration_direction: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"), ["AWAITING_DIRECTION"]);
      if ("error" in decl) return decl;
      return {
        title: `Validation finale (Directeur des Opérations) — déclaration ${decl.reference}`,
        fields: fieldsOf([
          ["Déclaration", `${decl.reference} — ${decl.label}`],
          ["Montant", decl.amount !== null ? dzd(toNumber(decl.amount)) : null],
          ["Commentaire", opStr(input, "note") || null],
        ]),
        warnings: ["Dernière marche : la déclaration passe VALIDÉE."],
        args: { id: decl.id, comment: opStr(input, "note") || null },
        successMessage: `Déclaration ${decl.reference} validée (validation finale).`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(validateDeclarationByDirection, args, "La validation finale a été refusée.", { revalidate: ["/information-medicale"] }),
  },

  comment_declaration: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decl = await resolveDeclaration(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in decl) return decl;
      const body = opStr(input, "message") || opStr(input, "note");
      if (!body) return { error: "Écrivez le message (champ « message »)." };
      return {
        title: `Message sur la déclaration ${decl.reference}`,
        fields: [
          { label: "Déclaration", value: `${decl.reference} — ${decl.label}` },
          { label: "Message", value: body },
        ],
        args: { declarationId: decl.id, body },
        successMessage: `Message posté sur ${decl.reference}.`,
        revalidate: ["/information-medicale"],
      };
    },
    execute: (args) => runFd(addMedicalInfoComment, args, "Le message a été refusé.", { revalidate: ["/information-medicale"] }),
  },
};
