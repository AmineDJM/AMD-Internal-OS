/**
 * OPS FLUX FINANCIERS — DEMANDES DE PAIEMENT : dossier (création, contact, soumission, décision,
 * annulation), fil de commentaires et revue des pièces, par les actions canoniques.
 */
import { prisma } from "./erp";
import { toNumber } from "@/lib/utils";
import { createPaymentRequest, submitPaymentRequest, decidePaymentRequest, cancelPaymentRequest, addPaymentComment, commentPaymentPiece, reviewPaymentPiece, updatePaymentRequestDetails } from "@/modules/finances/actions-demandes";
import type { PaymentMove } from "@/modules/finances/partage";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, dzd, fieldsOf, isoDate } from "../../helpers";
import { num } from "./commun";

/** Une demande de paiement par référence PAY-… ou titre. */
async function resolvePayment(raw: string) {
  const q = raw.trim();
  if (!q) return { error: "Précisez la référence (PAY-…) ou l'objet de la demande de paiement." } as const;
  const rows = await prisma.paymentRequest.findMany({
    where: { OR: [{ reference: { equals: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }, { payee: { contains: q, mode: "insensitive" } }] },
    select: {
      id: true, reference: true, title: true, amount: true, payee: true, status: true,
      contactName: true, contactPhone: true, contactEmail: true, paymentMethodStated: true,
    },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  if (rows.length === 0) return { error: `Aucune demande de paiement « ${q} ».` } as const;
  const exact = rows.filter((r) => r.reference.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  return { error: `Plusieurs demandes correspondent à « ${q} » : ${rows.map((r) => `${r.reference} — ${r.title} (${dzd(toNumber(r.amount))})`).join(" ; ")} — donner la référence exacte.` } as const;
}

/** Une pièce d'une demande de paiement, par le nom de son document. */
async function resolvePiece(requestId: string, reference: string, raw: string) {
  const pieces = await prisma.paymentPiece.findMany({
    where: { requestId },
    select: { id: true, status: true, documentId: true, note: true },
    orderBy: { position: "asc" },
  });
  if (pieces.length === 0) return { error: `Le dossier ${reference} n'a aucune pièce.` } as const;
  const docs = await prisma.document.findMany({
    where: { id: { in: pieces.map((p) => p.documentId) } }, select: { id: true, name: true },
  });
  const nameOf = new Map(docs.map((d) => [d.id, d.name] as const));
  const labeled = pieces.map((p) => ({ ...p, name: nameOf.get(p.documentId) ?? "(sans nom)" }));
  const q = raw.trim().toLowerCase();
  if (!q) {
    if (labeled.length === 1) return labeled[0];
    return { error: `Précisez la pièce (champ « piece ») parmi : ${labeled.map((p) => p.name).join(", ")}.` } as const;
  }
  const hits = labeled.filter((p) => p.name.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return { error: `Aucune pièce « ${raw} » dans ${reference} — pièces : ${labeled.map((p) => p.name).join(", ")}.` } as const;
  return { error: `Plusieurs pièces correspondent à « ${raw} » : ${hits.map((p) => p.name).join(", ")} — préciser.` } as const;
}

// ── Normalisations FR → énumérations (liste blanche, jamais du texte libre). ──

const MOVE_STEPS: [RegExp, PaymentMove, string][] = [
  [/instrui|examen|examin|review|charge/i, "REVIEW", "Prendre en instruction"],
  [/attente|suspend|hold|gele|gèle/i, "HOLD", "Mettre en attente"],
  [/repren|resume|relanc/i, "RESUME", "Reprendre l'instruction"],
  [/renvoi|revoir|correction|change/i, "REQUEST_CHANGES", "Renvoyer pour corrections"],
  [/refus|rejet/i, "REJECT", "Refuser"],
  [/approuv|accord|bon [àa] payer|\bpayer\b|valide/i, "APPROVE", "Bon à payer"],
];

function moveOf(raw: string): { move: PaymentMove; label: string } | null {
  const up = raw.toUpperCase().trim();
  const direct = MOVE_STEPS.find(([, m]) => m === up);
  if (direct) return { move: direct[1], label: direct[2] };
  const hit = MOVE_STEPS.find(([re]) => re.test(raw));
  return hit ? { move: hit[1], label: hit[2] } : null;
}

function urgencyOf(raw: string): { code: string; label: string } {
  const k = raw.toLowerCase();
  if (/urgent/.test(k)) return { code: "URGENT", label: "Urgent" };
  if (/semaine|week/.test(k)) return { code: "THIS_WEEK", label: "Cette semaine" };
  if (/mois|month/.test(k)) return { code: "THIS_MONTH", label: "Ce mois-ci" };
  return { code: "WHEN_POSSIBLE", label: "Quand possible" };
}

/**
 * CE QUE LA PERSONNE DIT DE SON ÉCHÉANCE, ramené aux trois natures.
 *
 * On ne reconnaît QUE ce dont on est sûr, et `deadlineNatureOf` retombe sur « moyenne » pour tout
 * le reste : deviner « non négociable » derrière une phrase ambiguë ferait passer une demande
 * devant les autres sur un malentendu.
 */
function natureCodeOf(raw: string): string {
  const k = raw.toLowerCase();
  if (/fixe|non n[ée]gociable|imp[ée]rative|ferme|FIXED/i.test(k)) return "FIXED";
  if (/importante|prioritaire|IMPORTANT/i.test(k)) return "IMPORTANT";
  if (/moyenne|souple|indicative|MODERATE/i.test(k)) return "MODERATE";
  return raw;
}

/** Ce qu'on ÉCRIT dans la proposition. Une nature non reconnue n'est simplement pas affichée. */
const NATURE_FR: Record<string, string> = {
  FIXED: "Fixe, non négociable", IMPORTANT: "Importante", MODERATE: "Moyenne",
};

const VERDICT_FR: Record<string, string> = { ACCEPTED: "Acceptée", CHANGES_REQUESTED: "À revoir", REJECTED: "Refusée", PENDING: "Remise en attente" };

function verdictOf(raw: string): string | null {
  const up = raw.toUpperCase().trim();
  if (VERDICT_FR[up]) return up;
  const k = raw.toLowerCase();
  if (/accept|valide|conforme|ok/.test(k)) return "ACCEPTED";
  if (/revoir|corrig|change|reprend/.test(k)) return "CHANGES_REQUESTED";
  if (/refus|rejet/.test(k)) return "REJECTED";
  if (/attente|pending|neutre/.test(k)) return "PENDING";
  return null;
}

export const DEMANDES_PAIEMENT_OPS_IMPL: Record<string, OpImpl> = {
  // ─────────────── Demandes de paiement ───────────────

  /**
   * UNE DEMANDE DE PAIEMENT NE SE TRANSMET PAS DEPUIS LA CONVERSATION.
   *
   * Deux raisons, et elles tiennent toutes les deux à la même chose — ce que l'assistant ne peut
   * pas faire à la place d'une personne (§118-15) :
   *
   *   • une demande transmise doit porter un BON DE COMMANDE ou une FACTURE, et l'assistant n'a
   *     pas de fichier à joindre ; la transmettre échouerait à coup sûr, ou pire, exigerait de
   *     contourner la règle ;
   *   • cocher « le moyen de paiement figure sur le document » est une ATTESTATION : elle engage
   *     celui qui a la pièce sous les yeux. Un modèle ne peut pas attester d'un document qu'il
   *     n'a pas lu, et l'audit portera pourtant le nom d'une personne.
   *
   * L'op ouvre donc un BROUILLON, toujours — la personne y joint sa pièce, coche la case et
   * transmet depuis l'écran.
   */
  create_payment_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const title = opStr(input, "label") || opStr(input, "title");
      const payee = opStr(input, "payee");
      const amount = num(input, "amount");
      if (!title) return { error: "Précisez l'objet du paiement (champ « label »)." };
      if (!payee) return { error: "Précisez le bénéficiaire — à qui l'argent doit aller (champ « payee »)." };
      if (amount === null || amount <= 0) return { error: "Précisez le montant à payer (champ « amount »)." };
      const urgency = urgencyOf(opStr(input, "urgency"));
      const dueDate = isoDate(opStr(input, "dueDate"));
      // La chaîne part telle quelle : `deadlineNatureOf`, côté Finances, est seul juge de ce
      // qu'elle vaut — et retombe sur « moyenne » pour tout ce qu'il ne reconnaît pas.
      const nature = natureCodeOf(opStr(input, "deadlineNature") || opStr(input, "deadline"));
      return {
        title: `Demande de paiement (brouillon) — ${payee} · ${dzd(amount)}`,
        fields: fieldsOf([
          ["Objet", title], ["Bénéficiaire", payee], ["Montant", dzd(amount)],
          ["Échéance", dueDate], ["Nature de l'échéance", dueDate ? NATURE_FR[nature] ?? null : null],
          ["Urgence", dueDate ? null : urgency.label],
          ["Contact chez le bénéficiaire", opStr(input, "contactName") || null],
          ["Téléphone", opStr(input, "contactPhone") || null],
          ["Description", opStr(input, "description") || null],
        ]),
        warnings: [
          "BROUILLON : joignez le bon de commande ou la facture depuis le dossier, cochez que le moyen de paiement y figure, puis transmettez. Ces deux gestes engagent celui qui a la pièce sous les yeux — ils ne se délèguent pas.",
        ],
        args: {
          title, payee, amount: String(amount), description: opStr(input, "description") || null,
          dueDate, urgency: urgency.code, deadlineNature: nature, submit: "0",
          contactName: opStr(input, "contactName") || null,
          contactPhone: opStr(input, "contactPhone") || null,
          contactEmail: opStr(input, "contactEmail") || null,
        },
        successMessage: `Brouillon de demande de paiement créé (${payee}, ${dzd(amount)}) — joignez la pièce et transmettez depuis le dossier.`,
        link: "/validations/paiements", revalidate: ["/validations", "/validations/paiements"],
      };
    },
    execute: (args) => runFd2(createPaymentRequest, args, "La demande de paiement a été refusée.", { link: "/validations/paiements", revalidate: ["/validations", "/validations/paiements"] }),
  },

  /** Le contact du bénéficiaire — le seul champ de la demande qu'un modèle peut remplir seul. */
  update_payment_contact: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolvePayment(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      const name = opStr(input, "contactName") || opStr(input, "contact");
      const phone = opStr(input, "contactPhone") || opStr(input, "phone");
      const email = opStr(input, "contactEmail") || opStr(input, "email");
      if (!name && !phone && !email) return { error: "Donnez au moins un élément de contact : nom, téléphone ou e-mail." };
      return {
        title: `Contact du bénéficiaire — ${req.reference}`,
        fields: fieldsOf([
          ["Dossier", `${req.reference} — ${req.title} (${req.payee})`],
          ["Nom", name || null], ["Téléphone", phone || null], ["E-mail", email || null],
        ]),
        // L'action REMPLACE les trois champs : on rejoue ceux qu'on ne change pas, sinon donner
        // un téléphone effacerait le nom déjà saisi.
        args: {
          id: req.id,
          contactName: name || req.contactName || null,
          contactPhone: phone || req.contactPhone || null,
          contactEmail: email || req.contactEmail || null,
          paymentMethodStated: req.paymentMethodStated ? "1" : null,
        },
        successMessage: `Contact enregistré sur ${req.reference}.`,
        link: "/validations/paiements", revalidate: ["/validations", "/validations/paiements"],
      };
    },
    execute: (args) => runFd(updatePaymentRequestDetails, args, "Les précisions ont été refusées.", { revalidate: ["/validations", "/validations/paiements"] }),
  },

  submit_payment_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolvePayment(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      return {
        title: `Transmettre ${req.reference} aux Finances`,
        fields: [
          { label: "Dossier", value: `${req.reference} — ${req.title} (${dzd(toNumber(req.amount))})` },
          { label: "Bénéficiaire", value: req.payee },
        ],
        args: { id: req.id, note: opStr(input, "note") || null },
        successMessage: `Dossier ${req.reference} transmis aux Finances.`,
        link: "/validations/paiements", revalidate: ["/validations", "/validations/paiements"],
      };
    },
    execute: (args) => runFd(submitPaymentRequest, args, "La transmission a été refusée.", { revalidate: ["/validations", "/validations/paiements"] }),
  },

  decide_payment_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolvePayment(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      const mv = moveOf(opStr(input, "decision"));
      if (!mv) return { error: "Précisez le geste (champ « decision ») : instruire | mettre en attente | reprendre | renvoyer pour corrections | bon à payer | refuser." };
      const note = opStr(input, "note");
      if (mv.move === "HOLD" && !note) return { error: "Une mise en attente se motive (champ « note ») — le demandeur doit savoir pourquoi." };
      if (mv.move === "REJECT" && !note) return { error: "Un refus se motive (champ « note ») — c'est ce que lira le demandeur." };
      return {
        title: `${mv.label} — ${req.reference} (${dzd(toNumber(req.amount))})`,
        fields: fieldsOf([
          ["Dossier", `${req.reference} — ${req.title}`],
          ["Bénéficiaire", req.payee],
          ["Geste", mv.label],
          ["Motif / note", note || null],
        ]),
        warnings: mv.move === "APPROVE"
          ? ["BON À PAYER : le paiement passe par le Centre de paiement, qui l'autorise quel que soit son montant ; les Finances le règlent ensuite. Toutes les pièces doivent être acceptées."]
          : mv.move === "REJECT" ? ["Le dossier est clos sur ce refus ; le demandeur est notifié."] : [],
        args: { id: req.id, move: mv.move, note: note || null },
        successMessage: `${mv.label} — ${req.reference}.`,
        link: "/validations/paiements", revalidate: ["/validations", "/validations/paiements", "/centre-paiement"],
      };
    },
    execute: (args) => runFd(decidePaymentRequest, args, "La décision a été refusée.", { revalidate: ["/validations", "/validations/paiements", "/centre-paiement"] }),
  },

  cancel_payment_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolvePayment(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      return {
        title: `Retirer la demande de paiement ${req.reference}`,
        fields: [{ label: "Dossier", value: `${req.reference} — ${req.title} (${dzd(toNumber(req.amount))})` }],
        warnings: ["Le dossier est clos sans paiement ; les Finances sont prévenues s'il était chez elles."],
        args: { id: req.id, note: opStr(input, "note") || null },
        successMessage: `Demande ${req.reference} retirée.`,
        revalidate: ["/validations", "/validations/paiements"],
      };
    },
    execute: (args) => runFd(cancelPaymentRequest, args, "Le retrait a été refusé.", { revalidate: ["/validations", "/validations/paiements"] }),
  },

  add_payment_comment: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolvePayment(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      const message = opStr(input, "message") || opStr(input, "note");
      if (!message) return { error: "Écrivez le message (champ « message »)." };
      return {
        title: `Message dans le dossier ${req.reference}`,
        fields: [
          { label: "Dossier", value: `${req.reference} — ${req.title}` },
          { label: "Message", value: message },
        ],
        args: { requestId: req.id, message },
        successMessage: `Message ajouté au dossier ${req.reference}.`,
        revalidate: ["/validations/paiements"],
      };
    },
    execute: (args) => runFd(addPaymentComment, args, "Le message a été refusé.", { revalidate: ["/validations/paiements"] }),
  },

  /**
   * PLUS DE DEMANDE DE VALIDATION SUR UN PAIEMENT — ni sur le dossier, ni sur une pièce.
   *
   * `ask_payment_validation` et `ask_piece_validation` vivaient ici. Elles n'ont plus d'objet : un
   * dossier n'arrive aux Finances QU'AUTORISÉ par le centre de paiement, et faire valider ce qui
   * vient d'être validé n'aboutit nulle part. Elles ont été supprimées à l'écran ET ici — un geste
   * que l'écran ne propose plus mais que l'assistant peut encore poser est une porte dérobée
   * (§118-7). Ce qui reste : réclamer une PIÈCE, qui n'est pas une décision.
   */

  comment_payment_piece: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolvePayment(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      const piece = await resolvePiece(req.id, req.reference, opStr(input, "piece"));
      if ("error" in piece) return piece;
      const note = opStr(input, "note") || opStr(input, "message");
      if (!note) return { error: "Écrivez le commentaire de la pièce (champ « note »)." };
      return {
        title: `Commenter la pièce « ${piece.name} » (${req.reference})`,
        fields: [
          { label: "Pièce", value: piece.name },
          { label: "Commentaire", value: note },
        ],
        args: { pieceId: piece.id, note },
        successMessage: `Commentaire posé sur « ${piece.name} ».`,
        revalidate: ["/validations/paiements"],
      };
    },
    execute: (args) => runFd(commentPaymentPiece, args, "Le commentaire a été refusé.", { revalidate: ["/validations/paiements"] }),
  },

  review_payment_piece: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolvePayment(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      const piece = await resolvePiece(req.id, req.reference, opStr(input, "piece"));
      if ("error" in piece) return piece;
      const verdict = verdictOf(opStr(input, "verdict") || opStr(input, "decision"));
      if (!verdict) return { error: "Précisez le verdict (champ « verdict ») : accepter | à revoir | refuser." };
      const note = opStr(input, "note");
      if ((verdict === "CHANGES_REQUESTED" || verdict === "REJECTED") && !note) {
        return { error: "Dites ce qui ne va pas (champ « note ») — sans motif, la pièce reviendra identique." };
      }
      return {
        title: `${VERDICT_FR[verdict]} — pièce « ${piece.name} » (${req.reference})`,
        fields: fieldsOf([
          ["Dossier", `${req.reference} — ${req.title}`],
          ["Pièce", piece.name],
          ["Verdict", VERDICT_FR[verdict]],
          ["Motif", note || null],
        ]),
        warnings: verdict === "CHANGES_REQUESTED" || verdict === "REJECTED"
          ? ["Le dossier repasse automatiquement chez le demandeur si une pièce est mise en cause."] : [],
        args: { pieceId: piece.id, verdict, note: note || null },
        successMessage: `Pièce « ${piece.name} » : ${VERDICT_FR[verdict].toLowerCase()}.`,
        revalidate: ["/validations/paiements"],
      };
    },
    execute: (args) => runFd(reviewPaymentPiece, args, "Le verdict a été refusé.", { revalidate: ["/validations/paiements"] }),
  },
};
