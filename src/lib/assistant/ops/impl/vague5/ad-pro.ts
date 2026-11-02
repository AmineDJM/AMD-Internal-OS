/**
 * OPS VAGUE 5a — AD & PRO : sponsoring (validation finale, clôture, réouverture, appel), circuit
 * congrès/événement, personnes prises en charge, POSTES de dépense de bout en bout (devis →
 * validation → budget → BC visé → émission), demandes « autres », correction de fiche par liste
 * blanche, seuils. Par les actions canoniques.
 */
import { prisma } from "./erp";
import { sponsoringAppeal, cloturerSponsoring, rouvrirSponsoring, requestThirdPartyInput as sponsoringThirdParty } from "@/modules/ad-pro/actions-sponsoring";
import { cancelCongressRequest, requestThirdPartyInput as congressThirdParty } from "@/modules/ad-pro/actions-congres";
import { addCongressBeneficiary, removeCongressBeneficiary, requestBeneficiaryIds } from "@/modules/ad-pro/actions-congres-beneficiaires";
import { addAdProItem, updateAdProItem, deleteAdProItem, linkPromoMaterial, submitAdProItem, setAdProItemBudget, demanderPieceSecretariat, requestAdProItemOrder, approveAdProItemOrder } from "@/modules/ad-pro/actions-postes";
import { createAdProOtherRequest, decideAdProOtherRequest, closeAdProOtherRequest } from "@/modules/ad-pro/actions-autres";
import { updateAdProRequest } from "@/modules/ad-pro/actions-edition";
import { demandesAuCentreAdPro, deciderVisaCentreAdPro, setAdProDgThreshold, setBcValidationThreshold, DEFAULT_APP_SETTINGS, PIECE_SECRETARIAT, NATURES_PIECE_SECRETARIAT, type NaturePieceSecretariat, bilanCloture, postesPourCloture } from "@/platform/in-process/capacites";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, fieldsOf, resolveOne, dzd, toFd } from "../../helpers";
import { fold } from "../../impl-regulatory";
import { resolveMissionParent, type MissionParent } from "../vague2b/missions";
import { CHEMIN_BONS_DE_COMMANDE } from "@/lib/chemins/bons-de-commande";
import { sansBloquer } from "@/lib/journal";
import { resolvePerson, decisionOf } from "./commun";

// ─────────────────────────── AD & PRO (sponsoring, congrès, postes) ───────────────────────────

interface SponsoringHit { id: string; reference: string; institution: string; status: string }

async function resolveSponsoring(raw: string): Promise<SponsoringHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez la demande de sponsoring (champ « reference » — SPO-AAAA-NNN ou institution)." };
  const exact = await prisma.sponsoringRequest.findFirst({
    where: { reference: { equals: q, mode: "insensitive" } },
    select: { id: true, reference: true, institution: true, status: true },
  });
  if (exact) return exact;
  const rows = await prisma.sponsoringRequest.findMany({
    where: { OR: [{ reference: { contains: q, mode: "insensitive" } }, { institution: { contains: q, mode: "insensitive" } }] },
    select: { id: true, reference: true, institution: true, status: true },
    orderBy: { createdAt: "desc" }, take: 6,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `Aucune demande de sponsoring « ${q} ».` };
  return { error: `Plusieurs demandes correspondent : ${rows.map((s) => `${s.reference} — ${s.institution}`).join(" ; ")} — donner la référence exacte.` };
}

/** Cible du circuit congrès / événement (JAMAIS un sponsoring — il a ses propres ops). */
async function resolveCongressTarget(kindRaw: string, labelRaw: string): Promise<(MissionParent & { congressType: string }) | { error: string }> {
  const parent = await resolveMissionParent(kindRaw || "congrès ou événement", labelRaw);
  if ("error" in parent) return parent;
  if (parent.entityType === "SPONSORING") {
    return { error: "Un SPONSORING suit son circuit par `advance_workflow` (approuver / refuser l'étape en cours), puis se clôture par `close_sponsoring`." };
  }
  const congressType = parent.entityType === "EVENT" ? "EVENT" : parent.entityType === "CONGRESS_NATIONAL" ? "NATIONAL" : "INTL";
  return { ...parent, congressType };
}

export const ADPRO5_OPS_IMPL: Record<string, OpImpl> = {
  // LES ANCIENNES DÉCISIONS HORS CIRCUIT ONT DISPARU (§118.151). `decide_sponsoring_preliminary`,
  // `analyze_sponsoring` et `decide_sponsoring_final` écrivaient le statut sans le moteur : la
  // dernière accordait un montant GLOBAL en sautant la pré-validation de la tenue, les postes et
  // la clôture — une porte ouverte à côté de la porte gardée (§118.71). Le circuit se conduit par
  // `advance_workflow` (le moteur, ses gardes, son tamis) ; la fin se prononce ici.

  close_sponsoring: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveSponsoring(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      // LE BILAN AVANT LA CARTE : une carte qui propose une clôture que l'action refusera est un
      // geste offert puis retiré (§118.83). Le refus dit TOUT ce qui manque, en une fois.
      const bilan = bilanCloture(req.status, await postesPourCloture(req.id));
      if (!bilan.cloturable) return { error: `Clôture impossible pour ${req.reference} — ${bilan.manques.join(" ; ")}.` };
      const note = opStr(input, "note") || null;
      return {
        title: `VALIDER ET CLÔTURER le sponsoring ${req.reference}`,
        fields: fieldsOf([
          ["Demande", `${req.reference} — ${req.institution}`],
          ["Postes accordés", String(bilan.accordes)],
          ["Postes refusés", bilan.refuses > 0 ? String(bilan.refuses) : null],
          ["Montant accordé (somme des postes accordés)", dzd(bilan.total)],
          ["Note", note],
        ]),
        warnings: [
          "La clôture FIGE les postes, leurs montants et leurs budgets : le total devient le montant accordé de la demande.",
          "Les BC et factures des postes accordés continuent leur chemin ; pour corriger un poste, il faudra rouvrir la demande.",
        ],
        args: { id: req.id, note },
        successMessage: `Sponsoring ${req.reference} validé et clôturé — ${dzd(bilan.total)}.`,
        link: `/sponsoring/${req.id}`, revalidate: ["/sponsoring"],
      };
    },
    execute: (args) => runFd(cloturerSponsoring, args, "La clôture a été refusée.", { revalidate: ["/sponsoring"] }),
  },

  reopen_sponsoring: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveSponsoring(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      const reason = opStr(input, "note") || opStr(input, "message");
      if (!reason) return { error: "Le motif de la réouverture est obligatoire (champ « note »)." };
      if (req.status !== "CLOSED") return { error: `${req.reference} n'est pas clôturée : il n'y a rien à rouvrir.` };
      return {
        title: `ROUVRIR le sponsoring clôturé ${req.reference}`,
        fields: fieldsOf([
          ["Demande", `${req.reference} — ${req.institution}`],
          ["Motif", reason],
        ]),
        warnings: ["La demande repasse en « tenue pré-validée » : son montant accordé est retiré jusqu'à la prochaine clôture."],
        args: { id: req.id, reason },
        successMessage: `Sponsoring ${req.reference} rouvert — ses postes se modifient à nouveau.`,
        link: `/sponsoring/${req.id}`, revalidate: ["/sponsoring"],
      };
    },
    execute: (args) => runFd(rouvrirSponsoring, args, "La réouverture a été refusée.", { revalidate: ["/sponsoring"] }),
  },

  appeal_sponsoring: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveSponsoring(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      const reason = opStr(input, "note") || opStr(input, "message");
      if (!reason) return { error: "Précisez le motif de l'appel (champ « note »)." };
      return {
        title: `Faire APPEL sur le sponsoring ${req.reference}`,
        fields: [
          { label: "Demande", value: `${req.reference} — ${req.institution}` },
          { label: "Motif de l'appel", value: reason },
        ],
        warnings: ["L'appel rouvre le circuit de validation de la demande — il repasse par ses étapes."],
        args: { id: req.id, reason },
        successMessage: `Appel enregistré sur ${req.reference} — le circuit est rouvert.`,
        link: `/sponsoring/${req.id}`, revalidate: ["/sponsoring"],
      };
    },
    execute: (args) => runFd(sponsoringAppeal, args, "L'appel a été refusé.", { revalidate: ["/sponsoring"] }),
  },

  involve_third_party: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const person = await resolvePerson(opStr(input, "person"), "la personne à impliquer (champ « person »)");
      if ("error" in person) return person;
      const kindRaw = opStr(input, "kind");
      if (/sponsor/i.test(kindRaw) || (!kindRaw && opStr(input, "reference").toUpperCase().startsWith("SPO-"))) {
        const req = await resolveSponsoring(opStr(input, "reference") || opStr(input, "target"));
        if ("error" in req) return req;
        return {
          title: `Impliquer ${person.name} — sponsoring ${req.reference}`,
          fields: fieldsOf([
            ["Demande", `${req.reference} — ${req.institution}`],
            ["Personne", person.name], ["Note", opStr(input, "note") || null],
          ]),
          warnings: ["La personne reçoit une demande de validation dans SON espace (sans budget, sans accès au module)."],
          args: { id: req.id, personId: person.id, note: opStr(input, "note") || null, sponsoring: "1" },
          successMessage: `${person.name} impliqué·e sur ${req.reference}.`,
          revalidate: ["/sponsoring"],
        };
      }
      const target = await resolveCongressTarget(kindRaw, opStr(input, "target") || opStr(input, "reference"));
      if ("error" in target) return target;
      return {
        title: `Impliquer ${person.name} — ${target.label}`,
        fields: fieldsOf([
          ["Cible", target.label], ["Personne", person.name], ["Note", opStr(input, "note") || null],
        ]),
        warnings: ["La personne reçoit une demande de validation dans SON espace (sans budget, sans accès au module)."],
        args: { id: target.entityId, type: target.congressType, personId: person.id, note: opStr(input, "note") || null, sponsoring: null },
        successMessage: `${person.name} impliqué·e sur ${target.label}.`,
        revalidate: ["/events"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("personId", args.personId ?? "");
      if (args.note) fd.set("note", args.note);
      if (args.sponsoring === "1") {
        const r = await sponsoringThirdParty(fd);
        if (!r.ok) return { ok: false, error: r.error ?? "L'implication a été refusée." };
        return { ok: true, revalidate: ["/sponsoring"] };
      }
      fd.set("type", args.type ?? "INTL");
      const r = await congressThirdParty(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'implication a été refusée." };
      return { ok: true, revalidate: ["/events"] };
    },
  },

  // LES ANCIENNES DÉCISIONS CONGRÈS / ÉVÉNEMENT HORS CIRCUIT ONT DISPARU (Direction, 27/10).
  // `decide_congress_preliminary`, `analyze_congress`, `decide_congress_final` et
  // `update_congress_budget` écrivaient `requestStatus` (et le montant accordé) sans le moteur :
  // l'écran ne les propose plus. Adam passe par les MÊMES gestes que l'écran — `advance_workflow`
  // pour le circuit, les postes pour le montant.

  cancel_congress_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const target = await resolveCongressTarget(opStr(input, "kind"), opStr(input, "target") || opStr(input, "reference"));
      if ("error" in target) return target;
      // LE MOTIF EST OBLIGATOIRE depuis que l'annulation ferme le circuit (§118.186) : l'action le
      // refuse sans lui, et une carte qui part sans motif promettrait un geste qui échoue au clic.
      const motif = opStr(input, "motif") || opStr(input, "reason") || opStr(input, "note");
      if (!motif) return { error: "Dites pourquoi retirer cette demande : le motif est obligatoire et reste au journal." };
      return {
        title: `Retirer la demande — ${target.label}`,
        fields: [{ label: "Demande", value: target.label }, { label: "Motif", value: motif }],
        warnings: [
          "Retirer SUPPRIME la demande, avec ses postes, ses pièces et ce qui en découle (circuit, validations, ordres non réglés). Elle reste récupérable depuis la corbeille par le Super Admin.",
          "Une demande déjà VALIDÉE ne se retire plus par ce geste, ni une demande dont de l'argent est déjà parti (l'action refuse).",
        ],
        args: { id: target.entityId, type: target.congressType, motif },
        successMessage: `Demande ${target.label} retirée — supprimée, récupérable depuis la corbeille.`,
        revalidate: ["/events"],
      };
    },
    execute: (args) => runFd(cancelCongressRequest, args, "L'annulation a été refusée.", { revalidate: ["/events"] }),
  },

  add_congress_beneficiary: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const target = await resolveCongressTarget(opStr(input, "kind") || "congrès", opStr(input, "target") || opStr(input, "reference"));
      if ("error" in target) return target;
      if (target.congressType === "EVENT") return { error: "Les personnes prises en charge se gèrent sur les CONGRÈS (national / international)." };
      const raw = opStr(input, "person");
      if (!raw) return { error: "Précisez la personne (champ « person » — nom de l'annuaire, ou nom libre)." };
      const doctors = await prisma.medicalDoctor.findMany({
        where: { name: { contains: raw, mode: "insensitive" } }, select: { id: true, name: true }, take: 4,
      });
      const doctor = doctors.length === 1 ? doctors[0] : null;
      if (doctors.length > 1) return { error: `Plusieurs praticiens correspondent : ${doctors.map((d) => d.name).join(", ")} — préciser (ou donner un nom libre plus complet).` };
      return {
        title: `Prendre en charge ${doctor?.name ?? raw} — ${target.label}`,
        fields: fieldsOf([
          ["Congrès", target.label],
          ["Personne", doctor ? `${doctor.name} (annuaire)` : `${raw} (nom libre)`],
          ["Rôle", opStr(input, "role") || null],
        ]),
        args: {
          id: target.entityId, kind: target.congressType === "NATIONAL" ? "NATIONAL" : "INTERNATIONAL",
          doctorId: doctor?.id ?? null, name: doctor ? null : raw, role: opStr(input, "role") || null,
        },
        successMessage: `${doctor?.name ?? raw} ajouté·e aux personnes prises en charge (${target.label}).`,
        revalidate: ["/events"],
      };
    },
    execute: (args) => runFd(addCongressBeneficiary, args, "L'ajout a été refusé.", { revalidate: ["/events"] }),
  },

  remove_congress_beneficiary: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const target = await resolveCongressTarget(opStr(input, "kind") || "congrès", opStr(input, "target") || opStr(input, "reference"));
      if ("error" in target) return target;
      if (target.congressType === "EVENT") return { error: "Les personnes prises en charge se gèrent sur les CONGRÈS (national / international)." };
      const raw = fold(opStr(input, "person"));
      if (!raw) return { error: "Précisez la personne (champ « person »)." };
      // LA LISTE UNIQUE des professionnels proposés (`CareBeneficiary`, décision du 04/10/2026) — plus le
      // JSON du congrès, que l'écran n'écrit plus.
      const lignes = await prisma.careBeneficiary.findMany({
        where: target.congressType === "NATIONAL" ? { congressNationalId: target.entityId } : { congressInternationalId: target.entityId },
        select: { id: true, doctorId: true, firstName: true, lastName: true },
      });
      const medecins = await prisma.medicalDoctor.findMany({
        where: { id: { in: lignes.map((l) => l.doctorId).filter((x): x is string => Boolean(x)) } }, select: { id: true, name: true },
      });
      const nomDe = new Map(medecins.map((d) => [d.id, d.name]));
      const list = lignes.map((l) => ({ id: l.id, name: (l.doctorId ? nomDe.get(l.doctorId) : null) ?? [l.firstName, l.lastName].filter(Boolean).join(" ") }));
      const hits = list.filter((b) => fold(b.name).includes(raw));
      if (hits.length === 0) return { error: `Aucune personne « ${opStr(input, "person")} » prise en charge sur ${target.label}${list.length ? ` — présentes : ${list.map((b) => b.name).join(", ")}` : ""}.` };
      if (hits.length > 1) return { error: `Plusieurs personnes correspondent : ${hits.map((b) => b.name).join(", ")} — préciser.` };
      return {
        title: `Retirer ${hits[0].name} des personnes prises en charge`,
        fields: [{ label: "Personne", value: `${hits[0].name} — ${target.label}` }],
        args: { id: target.entityId, kind: target.congressType === "NATIONAL" ? "NATIONAL" : "INTERNATIONAL", benefId: hits[0].id },
        successMessage: `${hits[0].name} retiré·e de la prise en charge.`,
        revalidate: ["/events"],
      };
    },
    execute: (args) => runFd(removeCongressBeneficiary, args, "Le retrait a été refusé.", { revalidate: ["/events"] }),
  },

  request_beneficiary_ids: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const target = await resolveCongressTarget(opStr(input, "kind") || "congrès", opStr(input, "target") || opStr(input, "reference"));
      if ("error" in target) return target;
      if (target.congressType === "EVENT") return { error: "Les pièces se demandent sur les CONGRÈS (national / international)." };
      return {
        title: `Demander les pièces des professionnels — ${target.label}`,
        fields: [{ label: "Congrès", value: target.label }],
        warnings: ["Chaque professionnel proposé reçoit ses pièces à fournir (national : passeport ; international : passeport, visa, informations de voyage), et le DEMANDEUR est prévenu."],
        args: { id: target.entityId, kind: target.congressType === "NATIONAL" ? "NATIONAL" : "INTERNATIONAL" },
        successMessage: `Pièces demandées pour les professionnels proposés (${target.label}).`,
        revalidate: ["/events"],
      };
    },
    execute: (args) => runFd(requestBeneficiaryIds, args, "La demande a été refusée.", { revalidate: ["/events"] }),
  },

  add_item: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const parent = await resolveMissionParent(opStr(input, "kind"), opStr(input, "target") || opStr(input, "reference"));
      if ("error" in parent) return parent;
      const label = opStr(input, "label") || opStr(input, "name");
      if (!label) return { error: "Précisez le libellé du poste (champ « label »)." };
      const additional = /rallonge|suppl[ée]ment|en plus|additional/i.test(opStr(input, "mode"));
      return {
        title: `Ajouter le poste « ${label} » — ${parent.label}`,
        fields: fieldsOf([
          ["Opération", parent.label], ["Poste", label],
          ["Budget", additional ? "RALLONGE (en plus du budget accordé)" : "Inclus dans le budget accordé"],
          ["Estimation", opStr(input, "amount") ? dzd(Number(opStr(input, "amount"))) : null],
          ["Prestataire", opStr(input, "supplier") || null],
        ]),
        args: {
          parent: parent.entityType, parentId: parent.entityId, label,
          amountEstimated: opStr(input, "amount") || null, supplier: opStr(input, "supplier") || null,
          budgetKind: additional ? "ADDITIONAL" : null, notes: opStr(input, "notes") || null,
        },
        successMessage: `Poste « ${label} » ajouté à ${parent.label}.`,
        revalidate: ["/sponsoring"],
      };
    },
    execute: (args) => runFd2(addAdProItem, args, "L'ajout du poste a été refusé.", { revalidate: ["/sponsoring"] }),
  },

  update_item: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const found = await resolveItem(input);
      if ("error" in found) return found;
      const updates = fieldsOf([
        ["Libellé", opStr(input, "newName") || null],
        ["Estimation", opStr(input, "amount") ? dzd(Number(opStr(input, "amount"))) : null],
        ["Montant AFFECTÉ (Direction)", opStr(input, "grantedAmount") ? dzd(Number(opStr(input, "grantedAmount"))) : null],
        ["Prestataire", opStr(input, "supplier") || null],
        ["Notes", opStr(input, "notes") || null],
      ]);
      if (updates.length === 0) return { error: "Rien à changer : donnez newName, amount (estimation), grantedAmount (Direction), supplier ou notes." };
      return {
        title: `Modifier le poste « ${found.label} » (${found.parentLabel})`,
        fields: [{ label: "Poste", value: `${found.label} — ${found.parentLabel}` }, ...updates],
        warnings: opStr(input, "grantedAmount") ? ["Le montant AFFECTÉ engage l'argent : geste de la Direction — refusé si un ordre de dépense est déjà émis."] : [],
        args: {
          id: found.id, label: opStr(input, "newName") || null,
          amountEstimated: opStr(input, "amount") || null,
          amountGranted: opStr(input, "grantedAmount") || null,
          supplier: opStr(input, "supplier") || null, notes: opStr(input, "notes") || null,
        },
        successMessage: `Poste « ${opStr(input, "newName") || found.label} » modifié.`,
        revalidate: ["/sponsoring"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      if (args.label) fd.set("label", args.label);
      if (args.amountEstimated) fd.set("amountEstimated", args.amountEstimated);
      if (args.amountGranted) fd.set("amountGranted", args.amountGranted);
      if (args.supplier) fd.set("supplier", args.supplier);
      if (args.notes) fd.set("notes", args.notes);
      const r = await updateAdProItem(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La modification du poste a été refusée." };
      return { ok: true, revalidate: ["/sponsoring"] };
    },
  },

  delete_item: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const found = await resolveItem(input);
      if ("error" in found) return found;
      return {
        title: `SUPPRIMER le poste « ${found.label} » (${found.parentLabel})`,
        fields: [{ label: "Poste", value: `${found.label} — ${found.parentLabel}` }],
        warnings: ["Un poste dont l'ordre de dépense est émis n'est retirable que par la DIRECTION — l'ordre est alors ANNULÉ (trace comptable conservée) ; un matériel promo rattaché est conservé."],
        confirmText: found.label,
        args: { id: found.id },
        successMessage: `Poste « ${found.label} » retiré.`,
        revalidate: ["/sponsoring"],
      };
    },
    execute: (args) => runFd2(deleteAdProItem, args, "La suppression du poste a été refusée.", { revalidate: ["/sponsoring"] }),
  },

  submit_item: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const found = await resolveItem(input);
      if ("error" in found) return found;
      return {
        title: `Soumettre le poste « ${found.label} » à la Direction`,
        fields: fieldsOf([["Poste", `${found.label} — ${found.parentLabel}`], ["Note", opStr(input, "note") || null]]),
        warnings: ["La Direction accorde, refuse, ou demande à revoir le budget — chaque tour reste dans l'historique."],
        args: { id: found.id, note: opStr(input, "note") || null },
        successMessage: `Poste « ${found.label} » soumis à la Direction.`,
        revalidate: ["/sponsoring"],
      };
    },
    execute: (args) => runFd2(submitAdProItem, args, "La soumission du poste a été refusée.", { revalidate: ["/sponsoring"] }),
  },

  set_item_budget: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const found = await resolveItem(input);
      if ("error" in found) return found;
      const catRaw = opStr(input, "category");
      const clearing = /^(aucune?|retire)$/i.test(catRaw);
      let categoryId: string | null = null; let categoryLabel = "— (imputation retirée)";
      if (!clearing) {
        if (!catRaw) return { error: "Précisez la (sous-)catégorie budgétaire (champ « category » — « aucune » pour retirer l'imputation)." };
        const cats = await prisma.budgetCategoryLine.findMany({
          where: { name: { contains: catRaw, mode: "insensitive" } },
          select: { id: true, name: true, envelope: { select: { name: true } } }, take: 6,
        });
        if (cats.length === 0) return { error: `Aucune catégorie budgétaire « ${catRaw} ».` };
        if (cats.length > 1) return { error: `Plusieurs catégories correspondent : ${cats.map((c) => `${c.envelope.name} › ${c.name}`).join(" ; ")} — préciser.` };
        categoryId = cats[0].id; categoryLabel = `${cats[0].envelope.name} › ${cats[0].name}`;
      }
      return {
        title: `Imputer « ${found.label} » au budget ${categoryLabel}`,
        fields: [
          { label: "Poste", value: `${found.label} — ${found.parentLabel}` },
          { label: "Budget", value: categoryLabel },
        ],
        warnings: ["Geste de la DIRECTION, sur un poste ACCORDÉ — le budget choisi suit la dépense jusqu'aux Finances."],
        args: { id: found.id, budgetCategoryId: categoryId },
        successMessage: clearing ? `Imputation du poste « ${found.label} » retirée.` : `Poste « ${found.label} » imputé à ${categoryLabel}.`,
        revalidate: ["/sponsoring"],
      };
    },
    execute: (args) => runFd2(setAdProItemBudget, args, "L'imputation a été refusée.", { revalidate: ["/sponsoring"] }),
  },

  request_item_quote: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const found = await resolveItem(input);
      if ("error" in found) return found;
      // LA NATURE EST LUE, JAMAIS DEVINÉE. Un défaut silencieux sur « DEVIS » ferait ouvrir un
      // devis quand la personne a dit « facture » — et la carte annoncerait l'autre pièce.
      const brut = (opStr(input, "nature") || "DEVIS").toUpperCase();
      const nature = (NATURES_PIECE_SECRETARIAT as string[]).includes(brut)
        ? (brut as NaturePieceSecretariat)
        : null;
      if (!nature) {
        return { error: `Nature de pièce inconnue : « ${brut} ». Attendu : ${NATURES_PIECE_SECRETARIAT.join(" ou ")}.` };
      }
      const spec = PIECE_SECRETARIAT[nature];
      return {
        title: `Demander ${spec.libelle.toLowerCase() === "facture" ? "la facture" : "le devis"} du poste « ${found.label} » au secrétariat`,
        fields: fieldsOf([
          ["Poste", `${found.label} — ${found.parentLabel}`],
          ["Pièce", spec.libelle],
          ["Message", opStr(input, "note") || null],
        ]),
        warnings: [`Ouvre une DEMANDE ADMINISTRATIVE (Bureau du secrétariat) — les pièces déposées y seront jointes au poste.${nature === "FACTURE" ? " La facture se réclame APRÈS la demande d'émission du bon de commande." : ""}`],
        args: { id: found.id, nature, note: opStr(input, "note") || null },
        successMessage: `Demande de ${spec.libelle.toLowerCase()} ouverte pour « ${found.label} ».`,
        revalidate: ["/sponsoring", "/demandes"],
      };
    },
    execute: (args) => runFd2(demanderPieceSecretariat, args, "La demande de pièce a été refusée.", { revalidate: ["/sponsoring"] }),
  },

  request_item_order: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const found = await resolveItem(input);
      if ("error" in found) return found;
      return {
        title: `Demander l'émission du bon de commande — « ${found.label} »`,
        fields: fieldsOf([["Poste", `${found.label} — ${found.parentLabel}`], ["Note", opStr(input, "note") || null]]),
        warnings: ["La demande part chez l'assistante de direction, qui dépose le bon de commande sur le poste ; au-dessus du seuil, le centre de validation Ad & Pro le vise en parallèle. Exige un poste accordé, un montant affecté et un budget. Plusieurs assistantes : le choix se fait à l'écran."],
        args: { id: found.id, note: opStr(input, "note") || null },
        successMessage: `Bon de commande demandé à l'assistante de direction pour « ${found.label} ».`,
        revalidate: ["/sponsoring"],
      };
    },
    execute: (args) => runFd2(requestAdProItemOrder, args, "La demande d'émission a été refusée.", { revalidate: ["/sponsoring"] }),
  },

  approve_item_order: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const found = await resolveItem(input);
      if ("error" in found) return found;
      const refuse = decisionOf(opStr(input, "decision")) === "REJECT";
      return {
        title: `${refuse ? "REFUSER" : "VALIDER"} le bon de commande — « ${found.label} »`,
        fields: fieldsOf([["Poste", `${found.label} — ${found.parentLabel}`], ["Note", opStr(input, "note") || null]]),
        warnings: refuse
          ? ["Un refus se MOTIVE : sans motif, l'action le refuse — le demandeur doit savoir quoi corriger."]
          : ["Validation du CENTRE DE VALIDATION AD & PRO — la signature des Finances suit le bon de commande déposé par l'assistante ; le paiement part de la facture, au centre de paiement."],
        args: { id: found.id, decision: refuse ? "REFUSE" : "APPROVE", note: opStr(input, "note") || null },
        successMessage: refuse ? `Bon de commande refusé pour « ${found.label} ».` : `Bon de commande validé — transmis aux Finances.`,
        revalidate: ["/sponsoring"],
      };
    },
    execute: (args) => runFd2(approveAdProItemOrder, args, "Le visa a été refusé.", { revalidate: ["/sponsoring"] }),
  },

  link_item_promo_material: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const found = await resolveItem(input);
      if ("error" in found) return found;
      const pmRaw = opStr(input, "material");
      const clearing = /^(aucun|retire|d[ée]tache)/i.test(pmRaw);
      let pmId: string | null = null; let pmLabel = "— (détaché)";
      if (!clearing) {
        if (!pmRaw) return { error: "Précisez le matériel promotionnel (champ « material » — MP-… ou titre ; « aucun » pour détacher)." };
        const mats = await prisma.promoMaterial.findMany({
          where: { OR: [{ reference: { contains: pmRaw, mode: "insensitive" } }, { title: { contains: pmRaw, mode: "insensitive" } }], status: { not: "CANCELLED" } },
          select: { id: true, reference: true, title: true }, take: 6,
        });
        if (mats.length === 0) return { error: `Aucun matériel promotionnel « ${pmRaw} ».` };
        if (mats.length > 1) return { error: `Plusieurs matériels correspondent : ${mats.map((m) => `${m.reference} — ${m.title}`).join(" ; ")} — préciser.` };
        pmId = mats[0].id; pmLabel = `${mats[0].reference} — ${mats[0].title}`;
      }
      return {
        title: clearing ? `Détacher « ${found.label} » de son matériel promotionnel` : `Rattacher « ${found.label} » au matériel ${pmLabel}`,
        fields: [
          { label: "Poste", value: `${found.label} — ${found.parentLabel}` },
          { label: "Matériel", value: pmLabel },
        ],
        warnings: clearing ? [] : ["On RATTACHE, on ne recopie pas : le matériel garde son propre circuit (visa, conformité, agence, BAT)."],
        args: { id: found.id, promoMaterialId: pmId },
        successMessage: clearing ? `Poste « ${found.label} » détaché.` : `Poste « ${found.label} » rattaché à ${pmLabel}.`,
        revalidate: ["/sponsoring"],
      };
    },
    execute: (args) => runFd2(linkPromoMaterial, args, "Le rattachement a été refusé.", { revalidate: ["/sponsoring"] }),
  },

  create_other_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const title = opStr(input, "label") || opStr(input, "name");
      if (!title) return { error: "Précisez l'objet de la demande (champ « label »)." };
      const description = opStr(input, "notes") || opStr(input, "message");
      if (!description) return { error: "Décrivez la demande (champ « notes ») — c'est sur cette description que la décision se prendra." };
      return {
        title: `Demande Ad & Pro « autre » — ${title}`,
        fields: fieldsOf([
          ["Objet", title], ["Description", description],
          ["Bénéficiaire", opStr(input, "person") || null],
          ["Montant", opStr(input, "amount") ? dzd(Number(opStr(input, "amount"))) : null],
        ]),
        warnings: ["La demande suit le circuit Ad & Pro (référence automatique) : son N+1, le Directeur des opérations, puis la prévalidation de la Direction Marketing ; les postes s'ajoutent après."],
        args: { title, description, beneficiary: opStr(input, "person") || null, amount: opStr(input, "amount") || null },
        successMessage: `Demande « ${title} » créée — elle part dans son circuit de validation.`,
        revalidate: ["/ad-pro"],
      };
    },
    execute: (args) => runFd2(createAdProOtherRequest, args, "La création a été refusée.", { revalidate: ["/ad-pro"] }),
  },

  decide_other_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveOther(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      const decision = decisionOf(opStr(input, "decision"));
      if (!decision) return { error: "Précisez la décision (champ « decision ») : valider ou refuser." };
      return {
        title: `${decision === "APPROVE" ? "Valider" : "REFUSER"} la demande ${req.reference}`,
        fields: fieldsOf([["Demande", `${req.reference} — ${req.title}`], ["Motif / note", opStr(input, "note") || null]]),
        args: { id: req.id, approve: decision === "APPROVE" ? "1" : "0", note: opStr(input, "note") || null },
        successMessage: `Demande ${req.reference} ${decision === "APPROVE" ? "validée" : "refusée"}.`,
        revalidate: ["/ad-pro"],
      };
    },
    execute: (args) => runFd(decideAdProOtherRequest, args, "La décision a été refusée.", { revalidate: ["/ad-pro"] }),
  },

  close_other_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveOther(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      const cancel = /annul/i.test(opStr(input, "decision")) || /annul/i.test(opStr(input, "mode"));
      return {
        title: `${cancel ? "Annuler" : "Marquer terminée"} la demande ${req.reference}`,
        fields: [{ label: "Demande", value: `${req.reference} — ${req.title}` }],
        warnings: cancel ? [] : ["Seule une demande VALIDÉE se marque terminée."],
        args: { id: req.id, cancel: cancel ? "1" : null },
        successMessage: `Demande ${req.reference} ${cancel ? "annulée" : "terminée"}.`,
        revalidate: ["/ad-pro"],
      };
    },
    execute: (args) => runFd(closeAdProOtherRequest, args, "L'opération a été refusée.", { revalidate: ["/ad-pro"] }),
  },

  correct_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const parent = await resolveMissionParent(opStr(input, "kind"), opStr(input, "target") || opStr(input, "reference"));
      if ("error" in parent) return parent;
      const kind = parent.entityType === "EVENT" ? "EVENT" : parent.entityType;
      const updates: [string, string][] = [];
      for (const [inputKey, formKey] of CORRECTABLE_FIELDS) {
        const v = opStr(input, inputKey);
        if (v) updates.push([formKey, v]);
      }
      const shown = fieldsOf(CORRECTABLE_FIELDS.map(([inputKey, , label]) => [label, opStr(input, inputKey) || null] as [string, string | null]));
      if (updates.length === 0) return { error: "Rien à corriger : donnez city, specialty, products, notes (description), amount (montant demandé) ou startDate/endDate." };
      return {
        title: `Corriger la fiche — ${parent.label}`,
        fields: [{ label: "Demande", value: parent.label }, ...shown],
        warnings: ["Liste blanche de l'écran : les DÉCISIONS (montant accordé, statut, Direction Marketing) ne passent JAMAIS par ici ; après décision, seule la Direction corrige."],
        args: { kind, id: parent.entityId, ...Object.fromEntries(updates) },
        successMessage: `Fiche de ${parent.label} corrigée.`,
        revalidate: ["/sponsoring", "/events"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(args)) if (v != null) fd.set(k, v);
      const r = await updateAdProRequest(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La correction a été refusée." };
      return { ok: true, revalidate: ["/sponsoring", "/events"] };
    },
  },
  /**
   * LE VISA DU CENTRE — la cible se résout sur la LISTE DU CENTRE, pas sur une requête à part.
   *
   * `demandesAuCentreAdPro()` est le lecteur que l'écran utilise : la carte ne peut donc pas
   * proposer une ligne que le centre ne montre plus (§118.5). Elle rend les TROIS formes de
   * porte ; seule `VISA_CENTRE` se tranche ici — les deux autres sont des ÉTAPES de circuit,
   * qui se décident devant le dossier, et le refus le NOMME plutôt que de se taire (§118.30).
   *
   * Un REFUS sans motif est refusé AVANT la carte : l'action l'exigerait de toute façon, et
   * faire découvrir l'exigence après le clic coûterait un aller-retour pour rien (§118.18).
   */
  decide_gate_visa: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decision = decisionOf(opStr(input, "decision"));
      if (!decision) {
        return { error: "Précisez la décision (champ « decision ») : autoriser le dépassement, ou refuser." };
      }
      const note = opStr(input, "note");
      if (decision === "REJECT" && !note) {
        return { error: "Un REFUS de dépassement se motive (champ « note ») : c'est ce motif que le demandeur lira." };
      }

      const lignes = await demandesAuCentreAdPro();
      const cible = await resolveOne(
        opStr(input, "reference") || opStr(input, "label"),
        "la demande qui attend au centre (champ « reference » — référence ou intitulé)",
        async (q) => {
          const f = fold(q);
          return lignes.filter((l) => fold(l.reference ?? "").includes(f) || fold(l.intitule).includes(f));
        },
        (l) => `${l.reference ?? "(sans référence)"} — ${l.intitule}`,
      );
      if ("error" in cible) return cible;

      if (cible.forme !== "VISA_CENTRE") {
        return {
          error: `« ${cible.reference ?? cible.intitule} » ne se tranche pas par un visa : sa porte est une ÉTAPE `
            + `de son circuit, qui se décide devant le dossier (${cible.href}) — avec ses pièces, sa catégorie `
            + `budgétaire et le fil des avis.`,
        };
      }

      return {
        title: `${decision === "APPROVE" ? "AUTORISER" : "REFUSER"} le dépassement de seuil — ${cible.reference ?? cible.intitule}`,
        fields: fieldsOf([
          ["Demande", `${cible.reference ?? "(sans référence)"} — ${cible.intitule}`],
          ["Demandeur", cible.demandeur],
          ["Budget total", cible.montant == null ? "non renseigné" : dzd(cible.montant)],
          ["Seuil en vigueur", cible.seuil == null ? "aucun seuil actif" : dzd(cible.seuil)],
          ["Motif", note || null],
        ]),
        warnings: [
          decision === "APPROVE"
            ? "AUTORISER laisse la demande poursuivre son circuit au-delà du seuil — l'audit portera votre nom."
            : "REFUSER arrête la demande au centre : elle ne poursuit pas son circuit.",
        ],
        args: {
          entityType: cible.entityType,
          entityId: cible.entityId,
          approve: decision === "APPROVE" ? "1" : "0",
          note: note || null,
        },
        successMessage: `Dépassement ${decision === "APPROVE" ? "autorisé" : "refusé"} — ${cible.reference ?? cible.intitule}.`,
        revalidate: ["/centre-ad-pro"],
      };
    },
    execute: (args) => runFd(deciderVisaCentreAdPro, args, "La décision du centre a été refusée.", { revalidate: ["/centre-ad-pro"] }),
  },

  /**
   * LES DEUX SEUILS DU CENTRE (§118.149) — « tout BC supérieur à un montant configuré dans les
   * centres de validations Ad&Pro devra passer par la validation d'un des centres ».
   *
   * La carte montre l'AVANT et l'APRÈS, et l'exécution passe par l'action de l'ÉCRAN : même siège
   * (`siegeAuCentreAdPro`, revérifié), même borne, et — pour les bons de commande — le même
   * RÉAIGUILLAGE des BC en vol. La phrase rendue est celle de l'action, qui dit combien de BC ont
   * changé de chemin : l'annoncer d'ici serait deviner ce que le code a réellement déplacé.
   */
  set_bc_threshold: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const seuil = montantDeSeuil(opStr(input, "amount") || opStr(input, "value"));
      if ("error" in seuil) return seuil;
      const avant = await seuilsEnVigueur();
      if (avant.bc === seuil.valeur) {
        return { error: `Le seuil des bons de commande vaut déjà ${seuil.valeur > 0 ? dzd(seuil.valeur) : "0 (aucun seuil)"}.` };
      }
      return {
        title: `Régler le seuil des bons de commande — ${seuil.valeur > 0 ? dzd(seuil.valeur) : "aucun seuil"}`,
        fields: fieldsOf([
          ["Seuil des bons de commande", `${avant.bc > 0 ? dzd(avant.bc) : "aucun"} → ${seuil.valeur > 0 ? dzd(seuil.valeur) : "aucun"}`],
          ["Au-dessus", "un centre de validation (Ad & Pro si le BC en vient, le centre de validations sinon), puis la signature des Finances"],
          ["En deçà", seuil.valeur > 0 ? "directement à la signature des Finances" : "— (sans seuil, tout BC passe par un centre)"],
        ]),
        warnings: [
          "Le seuil vaut pour TOUS les bons de commande de la société. Les BC en cours qui changent de côté sont réaiguillés aussitôt ; une validation déjà donnée ou une signature ne se retirent pas.",
        ],
        args: { bcValidationThreshold: String(seuil.valeur) },
        successMessage: "Seuil des bons de commande réglé.",
        link: "/centre-ad-pro",
        revalidate: ["/centre-ad-pro", CHEMIN_BONS_DE_COMMANDE],
      };
    },
    async execute(args) {
      const r = await setBcValidationThreshold(toFd(args));
      if (!r.ok) return { ok: false, error: r.error ?? "Le réglage du seuil a été refusé." };
      return { ok: true, ...(r.message ? { message: r.message } : {}), link: "/centre-ad-pro", revalidate: ["/centre-ad-pro", CHEMIN_BONS_DE_COMMANDE] };
    },
  },

  set_request_threshold: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const seuil = montantDeSeuil(opStr(input, "amount") || opStr(input, "value"));
      if ("error" in seuil) return seuil;
      const avant = await seuilsEnVigueur();
      if (avant.demandes === seuil.valeur) {
        return { error: `Le seuil des demandes vaut déjà ${seuil.valeur > 0 ? dzd(seuil.valeur) : "0 (aucune validation du Directeur Général)"}.` };
      }
      return {
        title: `Régler le seuil des demandes Ad & Pro — ${seuil.valeur > 0 ? dzd(seuil.valeur) : "aucun seuil"}`,
        fields: fieldsOf([
          ["Seuil des demandes", `${avant.demandes > 0 ? dzd(avant.demandes) : "aucun"} → ${seuil.valeur > 0 ? dzd(seuil.valeur) : "aucun"}`],
          ["Effet", seuil.valeur > 0 ? "une demande Ad & Pro dont le budget total dépasse ce montant passe par le centre de validation Ad & Pro" : "plus aucune validation du Directeur Général sur les demandes"],
        ]),
        warnings: ["Ce seuil gouverne les DEMANDES ; celui des bons de commande est un réglage distinct."],
        args: { adProDgThreshold: String(seuil.valeur) },
        successMessage: `Seuil des demandes Ad & Pro réglé à ${seuil.valeur > 0 ? dzd(seuil.valeur) : "aucun"}.`,
        link: "/centre-ad-pro",
        revalidate: ["/centre-ad-pro", "/ad-pro"],
      };
    },
    execute: (args) => runFd(setAdProDgThreshold, args, "Le réglage du seuil a été refusé.", { link: "/centre-ad-pro", revalidate: ["/centre-ad-pro", "/ad-pro"] }),
  },

};

/**
 * UN MONTANT DE SEUIL tel qu'une personne le dit — « 500 000 », « 500000 DZD », « 1,2 million »
 * n'est PAS lu : on ne devine pas un multiplicateur (§104.5). Un nombre, ou un refus qui dit la
 * forme attendue.
 */
function montantDeSeuil(brut: string): { valeur: number } | { error: string } {
  const texte = brut.replace(/dzd|da\b/gi, "").replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  if (!texte) return { error: "Précisez le seuil en DZD (champ « amount ») — 0 pour « aucun seuil »." };
  if (!/^\d+(\.\d+)?$/.test(texte)) {
    return { error: `« ${brut} » ne se lit pas comme un montant : donnez un nombre en DZD (ex. 500000), 0 pour « aucun seuil ».` };
  }
  return { valeur: Math.round(Number(texte)) };
}

/** Les deux seuils EN VIGUEUR, lus sur la ligne unique des réglages (défauts de la plateforme sinon). */
async function seuilsEnVigueur(): Promise<{ demandes: number; bc: number }> {
  const row = await prisma.appSetting.findUnique({
    where: { id: "global" }, select: { adProDgThreshold: true, bcValidationThreshold: true },
  }).catch(sansBloquer("impl-wave5.seuilsEnVigueur.appSetting", null));
  return {
    demandes: row ? Number(row.adProDgThreshold) : DEFAULT_APP_SETTINGS.adProDgThreshold,
    bc: row ? Number(row.bcValidationThreshold) : DEFAULT_APP_SETTINGS.bcValidationThreshold,
  };
}

/** Champs corrigeables (entrée op → champ formulaire → libellé) — liste blanche côté action. */
const CORRECTABLE_FIELDS: [string, string, string][] = [
  ["city", "city", "Ville"], ["specialty", "specialty", "Spécialité"],
  ["products", "products", "Produits"], ["notes", "description", "Description"],
  ["amount", "amountRequested", "Montant demandé"],
  ["startDate", "startDate", "Début"], ["endDate", "endDate", "Fin"],
];

interface ItemHit { id: string; label: string; parentLabel: string }

async function resolveItem(input: Record<string, unknown>): Promise<ItemHit | { error: string }> {
  const parent = await resolveMissionParent(opStr(input, "kind"), opStr(input, "target") || opStr(input, "reference"));
  if ("error" in parent) return parent;
  const column = parent.entityType === "SPONSORING" ? "sponsoringId"
    : parent.entityType === "CONGRESS_NATIONAL" ? "congressNationalId"
    : parent.entityType === "CONGRESS_INTERNATIONAL" ? "congressInternationalId" : "eventId";
  const rows = await prisma.adProItem.findMany({
    where: { [column]: parent.entityId }, select: { id: true, label: true }, orderBy: { position: "asc" }, take: 30,
  });
  if (rows.length === 0) return { error: `${parent.label} n'a aucun poste de dépense.` };
  const q = fold(opStr(input, "label") || opStr(input, "name"));
  if (!q) {
    if (rows.length === 1) return { id: rows[0].id, label: rows[0].label, parentLabel: parent.label };
    return { error: `Précisez le poste (champ « label ») parmi : ${rows.map((r) => r.label).join(" ; ")}.` };
  }
  const hits = rows.filter((r) => fold(r.label).includes(q));
  if (hits.length === 1) return { id: hits[0].id, label: hits[0].label, parentLabel: parent.label };
  if (hits.length === 0) return { error: `Aucun poste « ${opStr(input, "label")} » sur ${parent.label} — postes : ${rows.map((r) => r.label).join(" ; ")}.` };
  return { error: `Plusieurs postes correspondent : ${hits.map((r) => r.label).join(" ; ")} — préciser.` };
}

const resolveOther = (raw: string) =>
  resolveOne(raw, "la demande « autre » (champ « reference » — AUT-… ou objet)",
    (q) => prisma.adProOtherRequest.findMany({
      where: { OR: [{ reference: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] },
      select: { id: true, reference: true, title: true }, orderBy: { createdAt: "desc" }, take: 6,
    }),
    (r) => `${r.reference} — ${r.title}`);
